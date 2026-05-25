// inject.js — runs in the page's MAIN world.
// Patches navigator.mediaDevices.getUserMedia so the page sees a processed video stream
// instead of the raw camera feed.
//
// Architecture:
//   real getUserMedia → MediaStream (raw)
//        ↓
//   <video> element draws frames
//        ↓
//   MediaPipe ImageSegmenter (selfie model) → person mask
//        ↓
//   OffscreenCanvas composites: foreground(person) over background(blur or image)
//        ↓
//   canvas.captureStream() → fake MediaStream returned to caller

(async function () {
  if (window.__bruceEffectCameraInstalled) return;
  window.__bruceEffectCameraInstalled = true;

  const SCRIPT = document.currentScript || (function () {
    const ss = document.getElementsByTagName('script');
    return ss[ss.length - 1];
  })();
  const ASSETS_BASE = SCRIPT?.dataset?.assetsBase || '';

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

  // Request initial config.
  window.postMessage({ source: 'bruce-effect-camera-inject', type: 'REQUEST_CONFIG' }, '*');

  // --- Bypass Trusted Types policy (e.g. webcamtests.com) so MediaPipe can
  //     create its internal worker <script> tags. ---
  if (window.trustedTypes && window.trustedTypes.createPolicy) {
    try {
      // Default policy: any code path that assigns a string to a TrustedScriptURL
      // sink will route through this and we hand back the string unchanged.
      window.trustedTypes.createPolicy('default', {
        createScriptURL: (s) => s,
        createScript: (s) => s,
        createHTML: (s) => s
      });
    } catch (e) {
      // Already created by the page — try a named policy MediaPipe-style code
      // can call into. (Not all sinks honor named policies, but worth a shot.)
      try {
        window.trustedTypes.createPolicy('bruce-effect', {
          createScriptURL: (s) => s,
          createScript: (s) => s,
          createHTML: (s) => s
        });
      } catch (_) { /* ignore */ }
    }
  }

  // --- Load MediaPipe segmenter lazily (only when first camera request happens) ---
  let segmenterPromise = null;
  async function getSegmenter() {
    if (segmenterPromise) return segmenterPromise;
    segmenterPromise = (async () => {
      const mod = await import(ASSETS_BASE + 'vision_bundle.mjs');
      const { ImageSegmenter, FilesetResolver } = mod;
      const fileset = await FilesetResolver.forVisionTasks(ASSETS_BASE);
      const segmenter = await ImageSegmenter.createFromOptions(fileset, {
        baseOptions: {
          modelAssetPath: ASSETS_BASE + 'selfie_segmenter.tflite',
          delegate: 'GPU'
        },
        runningMode: 'VIDEO',
        outputCategoryMask: true,
        outputConfidenceMasks: false
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

    // Video element to read frames from.
    const video = document.createElement('video');
    video.srcObject = realStream;
    video.muted = true;
    video.playsInline = true;
    await video.play().catch(() => {});

    // Canvases.
    const outCanvas = document.createElement('canvas');
    outCanvas.width = width;
    outCanvas.height = height;
    const outCtx = outCanvas.getContext('2d');

    const bgCanvas = document.createElement('canvas');
    bgCanvas.width = width;
    bgCanvas.height = height;
    const bgCtx = bgCanvas.getContext('2d');

    const maskCanvas = document.createElement('canvas');
    maskCanvas.width = width;
    maskCanvas.height = height;
    const maskCtx = maskCanvas.getContext('2d');

    let segmenter = null;
    try { segmenter = await getSegmenter(); }
    catch (e) { console.warn('[BruceEffect] Segmenter load failed, passthrough:', e); }

    let running = true;
    videoTrack.addEventListener('ended', () => { running = false; });

    function render() {
      if (!running) return;
      if (video.readyState < 2) { requestAnimationFrame(render); return; }

      try {
        const mode = config.mode || 'none';

        if (mode === 'none' || !segmenter) {
          outCtx.drawImage(video, 0, 0, width, height);
        } else {
          // 1. Run segmentation.
          const ts = performance.now();
          const result = segmenter.segmentForVideo(video, ts);
          const mask = result.categoryMask;
          // mask is a MPMask. Get the Uint8Array of category indices.
          const maskData = mask.getAsUint8Array();

          // 2. Build alpha mask in maskCanvas (person = opaque, bg = transparent).
          // Selfie segmenter: category 0 = background, 1 = person.
          const maskImage = maskCtx.createImageData(width, height);
          for (let i = 0; i < maskData.length; i++) {
            const isPerson = maskData[i] !== 0;
            const a = isPerson ? 255 : 0;
            const idx = i * 4;
            maskImage.data[idx] = 255;
            maskImage.data[idx + 1] = 255;
            maskImage.data[idx + 2] = 255;
            maskImage.data[idx + 3] = a;
          }
          maskCtx.putImageData(maskImage, 0, 0);
          mask.close();

          // 3. Build background.
          if (mode === 'blur') {
            const r = Math.max(1, Math.min(50, config.blurRadius || 15));
            bgCtx.filter = `blur(${r}px)`;
            bgCtx.drawImage(video, 0, 0, width, height);
            bgCtx.filter = 'none';
          } else if (mode === 'image' && bgImageElement) {
            // cover-fit
            const ir = bgImageElement.width / bgImageElement.height;
            const cr = width / height;
            let dw, dh, dx, dy;
            if (ir > cr) {
              dh = height;
              dw = height * ir;
              dx = (width - dw) / 2;
              dy = 0;
            } else {
              dw = width;
              dh = width / ir;
              dx = 0;
              dy = (height - dh) / 2;
            }
            bgCtx.drawImage(bgImageElement, dx, dy, dw, dh);
          } else {
            bgCtx.drawImage(video, 0, 0, width, height);
          }

          // 4. Composite: start with background, then draw person on top.
          outCtx.globalCompositeOperation = 'source-over';
          outCtx.drawImage(bgCanvas, 0, 0, width, height);

          // Person: draw video, then mask out background using destination-in with maskCanvas.
          // Use a temp pattern: draw video to a temp area? simpler: use second canvas.
          // Trick: drawImage video onto out, then destination-in with maskCanvas → keeps only person.
          // But that wipes the background we just drew. So we composite person on a temp canvas first.
          const personCanvas = bgCanvas; // reuse; we already used bg.
          // Actually let's use a third buffer to keep code clear.
          personCtx.clearRect(0, 0, width, height);
          personCtx.globalCompositeOperation = 'source-over';
          personCtx.drawImage(video, 0, 0, width, height);
          personCtx.globalCompositeOperation = 'destination-in';
          personCtx.drawImage(maskCanvas, 0, 0, width, height);
          personCtx.globalCompositeOperation = 'source-over';

          outCtx.drawImage(personCanvasEl, 0, 0, width, height);
        }
      } catch (e) {
        console.warn('[BruceEffect] render error:', e);
        outCtx.drawImage(video, 0, 0, width, height);
      }
      requestAnimationFrame(render);
    }

    // Third buffer for the person layer (declared late on purpose, see render).
    const personCanvasEl = document.createElement('canvas');
    personCanvasEl.width = width;
    personCanvasEl.height = height;
    const personCtx = personCanvasEl.getContext('2d');

    render();

    const outStream = outCanvas.captureStream(30);
    // Add audio tracks from real stream so meetings still have sound.
    realStream.getAudioTracks().forEach(t => outStream.addTrack(t));

    // When caller stops the fake stream, stop the real one too.
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
    // Only intercept when video is requested.
    if (!constraints || !constraints.video) return realGUM(constraints);

    const realStream = await realGUM(constraints);
    try {
      const fakeStream = await processStream(realStream);
      return fakeStream;
    } catch (e) {
      console.warn('[BruceEffect] passthrough due to error:', e);
      return realStream;
    }
  };

  // Older API some pages use.
  if (navigator.getUserMedia) {
    const legacy = navigator.getUserMedia.bind(navigator);
    navigator.getUserMedia = function (constraints, success, error) {
      md.getUserMedia(constraints).then(success).catch(error);
    };
  }

  console.log('[BruceEffect] installed');
})();
