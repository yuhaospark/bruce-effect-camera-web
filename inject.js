// inject.js — runs in the page's MAIN world.
// Patches navigator.mediaDevices.getUserMedia. WebGL renderer + multiclass selfie segmenter.

(async function () {
  if (window.__bruceEffectCameraInstalled) return;
  window.__bruceEffectCameraInstalled = true;

  const SCRIPT = document.currentScript || (function () {
    const ss = document.getElementsByTagName('script');
    return ss[ss.length - 1];
  })();
  const ASSETS_BASE = SCRIPT?.dataset?.assetsBase || '';
  const RENDERER_URL = SCRIPT?.dataset?.rendererUrl || '';

  // --- Config (kept in sync with chrome.storage via content.js) ---
  let config = { mode: 'none', blurRadius: 15, backgroundImage: null };
  let bgImageElement = null;
  let bgImageUrl = null;

  window.addEventListener('message', (ev) => {
    if (ev.source !== window) return;
    if (!ev.data || ev.data.source !== 'bruce-effect-camera') return;
    if (ev.data.type === 'BRUCE_EFFECT_CONFIG') {
      config = ev.data.config || config;
      maybeLoadBgImage();
    }
  });

  function maybeLoadBgImage() {
    if (config.mode !== 'image' || !config.backgroundImage) {
      bgImageElement = null;
      bgImageUrl = null;
      return;
    }
    if (config.backgroundImage === bgImageUrl) return;
    bgImageUrl = config.backgroundImage;
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => { bgImageElement = img; };
    img.onerror = () => { bgImageElement = null; };
    img.src = config.backgroundImage;
  }

  window.postMessage({ source: 'bruce-effect-camera-inject', type: 'REQUEST_CONFIG' }, '*');

  // --- Trusted Types bypass (webcamtests.com etc) ---
  if (window.trustedTypes && window.trustedTypes.createPolicy) {
    try {
      window.trustedTypes.createPolicy('default', {
        createScriptURL: (s) => s, createScript: (s) => s, createHTML: (s) => s
      });
    } catch (_) { /* default policy already set */ }
  }

  // --- Load WebGL renderer (sibling extension asset) ---
  async function loadRenderer() {
    if (window.BruceWebGLRenderer) return;
    const code = await (await fetch(RENDERER_URL)).text();
    const blob = new Blob([code], { type: 'text/javascript' });
    const url = URL.createObjectURL(blob);
    await import(/* webpackIgnore: true */ url);
    // Fallback: if dynamic import doesn't expose window globals (it does here since renderer
    // assigns to window.BruceWebGLRenderer directly), give a tiny delay.
    if (!window.BruceWebGLRenderer) {
      // Eval as inline script.
      const s = document.createElement('script');
      s.textContent = code;
      document.documentElement.appendChild(s);
      s.remove();
    }
  }

  // --- Load MediaPipe segmenter lazily ---
  let segmenterPromise = null;
  async function getSegmenter() {
    if (segmenterPromise) return segmenterPromise;
    segmenterPromise = (async () => {
      async function toBlobUrl(name, mime) {
        const r = await fetch(ASSETS_BASE + name);
        const buf = await r.arrayBuffer();
        return URL.createObjectURL(new Blob([buf], { type: mime }));
      }
      const [bundleUrl, loaderUrl, wasmUrl] = await Promise.all([
        toBlobUrl('vision_bundle.mjs',        'text/javascript'),
        toBlobUrl('vision_wasm_internal.js',  'text/javascript'),
        toBlobUrl('vision_wasm_internal.wasm','application/wasm'),
      ]);

      const mod = await import(bundleUrl);
      const { ImageSegmenter } = mod;

      const fileset = {
        wasmLoaderPath: loaderUrl,
        wasmBinaryPath: wasmUrl,
        assetLoaderPath: loaderUrl,
        assetBinaryPath: wasmUrl
      };

      // Multiclass model: better hair/edge handling.
      const modelBuf = await (await fetch(ASSETS_BASE + 'selfie_multiclass_256x256.tflite')).arrayBuffer();

      const segmenter = await ImageSegmenter.createFromOptions(fileset, {
        baseOptions: {
          modelAssetBuffer: new Uint8Array(modelBuf),
          delegate: 'GPU'
        },
        runningMode: 'VIDEO',
        outputCategoryMask: false,
        outputConfidenceMasks: true
      });
      return segmenter;
    })();
    return segmenterPromise;
  }

  // --- The processing pipeline. Returns a new MediaStream. ---
  async function processStream(realStream) {
    const videoTrack = realStream.getVideoTracks()[0];
    if (!videoTrack) return realStream;
    const settings = videoTrack.getSettings();
    const width = settings.width || 1280;
    const height = settings.height || 720;

    const video = document.createElement('video');
    video.srcObject = realStream;
    video.muted = true;
    video.playsInline = true;
    await video.play().catch(() => {});

    await loadRenderer();
    const renderer = new window.BruceWebGLRenderer(width, height);

    let segmenter = null;
    try { segmenter = await getSegmenter(); }
    catch (e) { console.warn('[BruceEffect] Segmenter load failed, passthrough:', e); }

    // Temporal smoothing buffers (CPU side, per-pixel float).
    let prevMask = null;

    let running = true;
    videoTrack.addEventListener('ended', () => { running = false; });

    // Multiclass categories (selfie_multiclass_256x256):
    //   0 = background
    //   1 = hair
    //   2 = body-skin
    //   3 = face-skin
    //   4 = clothes
    //   5 = others (accessories)
    // We want person = 1..5.
    const PERSON_CATS = [1, 2, 3, 4, 5];

    function render() {
      if (!running) return;
      if (video.readyState < 2) { requestAnimationFrame(render); return; }

      try {
        if (config.mode === 'none' || !segmenter) {
          renderer.render(video, new Float32Array(1), 1, 1, { mode: 'none' }, null);
        } else {
          const ts = performance.now();
          const result = segmenter.segmentForVideo(video, ts);
          const cmasks = result.confidenceMasks;
          if (!cmasks || cmasks.length === 0) {
            renderer.render(video, new Float32Array(1), 1, 1, { mode: 'none' }, null);
            requestAnimationFrame(render);
            return;
          }

          // Combine: person_confidence(i) = sum of cmasks[cat][i] for cat in PERSON_CATS.
          const mw = cmasks[0].width;
          const mh = cmasks[0].height;
          const N = mw * mh;
          let combined = new Float32Array(N);
          for (const cat of PERSON_CATS) {
            if (cat >= cmasks.length) continue;
            const arr = cmasks[cat].getAsFloat32Array();
            for (let i = 0; i < N; i++) combined[i] += arr[i];
          }
          // Clamp.
          for (let i = 0; i < N; i++) if (combined[i] > 1) combined[i] = 1;
          for (const m of cmasks) m.close();

          // Temporal smoothing.
          if (!prevMask || prevMask.length !== N) {
            prevMask = new Float32Array(combined);
          } else {
            const alpha = 0.55;     // weight of previous frame (higher = smoother but laggier)
            for (let i = 0; i < N; i++) {
              prevMask[i] = prevMask[i] * alpha + combined[i] * (1 - alpha);
            }
            combined = prevMask;
          }

          renderer.render(video, combined, mw, mh, config, bgImageElement);
        }
      } catch (e) {
        console.warn('[BruceEffect] render error:', e);
        renderer.render(video, new Float32Array(1), 1, 1, { mode: 'none' }, null);
      }
      requestAnimationFrame(render);
    }
    render();

    const outStream = renderer.canvas.captureStream(30);
    realStream.getAudioTracks().forEach(t => outStream.addTrack(t));
    outStream.getVideoTracks()[0].addEventListener('ended', () => {
      running = false;
      videoTrack.stop();
    });
    return outStream;
  }

  // --- Patch getUserMedia ---
  const md = navigator.mediaDevices;
  if (!md || !md.getUserMedia) return;
  const realGUM = md.getUserMedia.bind(md);

  md.getUserMedia = async function (constraints) {
    if (!constraints || !constraints.video) return realGUM(constraints);
    const realStream = await realGUM(constraints);
    try {
      return await processStream(realStream);
    } catch (e) {
      console.warn('[BruceEffect] passthrough due to error:', e);
      return realStream;
    }
  };

  if (navigator.getUserMedia) {
    navigator.getUserMedia = function (constraints, success, error) {
      md.getUserMedia(constraints).then(success).catch(error);
    };
  }

  console.log('[BruceEffect] installed (WebGL + multiclass)');
})();
