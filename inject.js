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
      // Some hosts (Google Meet, etc.) have a strict script-src CSP that blocks
      // chrome-extension:// <script src>. MediaPipe internally injects a
      // <script> to load its wasm glue, so we prefetch into blob: URLs which
      // virtually every CSP allows.
      async function toBlobUrl(name, mime) {
        const r = await fetch(ASSETS_BASE + name);
        const b = await r.blob();
        return URL.createObjectURL(new Blob([await b.arrayBuffer()], { type: mime }));
      }
      const [bundleUrl, loaderUrl, wasmUrl] = await Promise.all([
        toBlobUrl('vision_bundle.mjs',        'text/javascript'),
        toBlobUrl('vision_wasm_internal.js',  'text/javascript'),
        toBlobUrl('vision_wasm_internal.wasm','application/wasm'),
      ]);

      const mod = await import(bundleUrl);
      const { ImageSegmenter, FaceDetector } = mod;
      // Stash FaceDetector ctor + fileset for the separate loader below.
      window.__bruceEffect_FaceDetector = FaceDetector;
      window.__bruceEffect_fileset = null;     // set below

      // Build the fileset object manually — same shape MediaPipe expects.
      const fileset = {
        wasmLoaderPath: loaderUrl,
        wasmBinaryPath: wasmUrl,
        assetLoaderPath: loaderUrl,
        assetBinaryPath: wasmUrl
      };
      window.__bruceEffect_fileset = fileset;

      // Model file too: fetch as ArrayBuffer and hand to baseOptions.modelAssetBuffer
      const modelBuf = await (await fetch(ASSETS_BASE + 'selfie_segmenter.tflite')).arrayBuffer();

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

  // --- Face detector (gates the person mask to people whose face is visible) ---
  let faceDetectorPromise = null;
  async function getFaceDetector() {
    if (faceDetectorPromise) return faceDetectorPromise;
    faceDetectorPromise = (async () => {
      // Make sure segmenter loader has populated the fileset + ctor.
      await getSegmenter();
      const FaceDetector = window.__bruceEffect_FaceDetector;
      const fileset = window.__bruceEffect_fileset;
      if (!FaceDetector || !fileset) throw new Error('FaceDetector unavailable');
      const modelBuf = await (await fetch(ASSETS_BASE + 'blaze_face_short_range.tflite')).arrayBuffer();
      const detector = await FaceDetector.createFromOptions(fileset, {
        baseOptions: {
          modelAssetBuffer: new Uint8Array(modelBuf),
          delegate: 'GPU'
        },
        runningMode: 'VIDEO',
        minDetectionConfidence: 0.5
      });
      return detector;
    })();
    return faceDetectorPromise;
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

    let faceDetector = null;
    try { faceDetector = await getFaceDetector(); }
    catch (e) { console.warn('[BruceEffect] FaceDetector load failed, no face gating:', e); }

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
          // 1. Run segmentation -> soft confidence mask (Float32, 0..1 = bg probability or person probability)
          const ts = performance.now();
          const result = segmenter.segmentForVideo(video, ts);
          const cmasks = result.confidenceMasks;
          if (!cmasks || cmasks.length === 0) {
            outCtx.drawImage(video, 0, 0, width, height);
            requestAnimationFrame(render);
            return;
          }
          // selfie_segmenter outputs one confidence mask. Empirically: high value = person.
          const cmask = cmasks[0];
          const mw = cmask.width;
          const mh = cmask.height;
          const cdata = cmask.getAsFloat32Array();

          // 2. Build soft alpha mask at the model's native size (256x256 typically).
          //    Drawing it scaled into maskCanvas gives free bilinear filtering -> smoother edges.
          const smallCanvas = smallMaskCanvas;
          smallCanvas.width = mw;
          smallCanvas.height = mh;
          const smallCtx = smallCanvasCtx;
          const smallImage = smallCtx.createImageData(mw, mh);
          // Soften by remapping confidence with a smoothstep around 0.5 to keep
          // mostly-opaque interior and mostly-transparent background, but with a
          // gentle ramp at the edges.
          for (let i = 0; i < cdata.length; i++) {
            const v = cdata[i];                       // 0..1, higher = person
            // Wider smoothstep (0.2..0.8) for a gentler ramp.
            const t = Math.max(0, Math.min(1, (v - 0.2) / 0.6));
            const a = (t * t * (3 - 2 * t)) * 255;
            const idx = i * 4;
            smallImage.data[idx] = 255;
            smallImage.data[idx + 1] = 255;
            smallImage.data[idx + 2] = 255;
            smallImage.data[idx + 3] = a;
          }
          smallCtx.putImageData(smallImage, 0, 0);
          cmask.close();

          // Upscale with bilinear filter + heavy blur on the alpha for soft feather.
          // First upscale to an intermediate size to avoid blocky bilinear when going 256 -> 1280 directly.
          maskCtx.save();
          maskCtx.clearRect(0, 0, width, height);
          maskCtx.imageSmoothingEnabled = true;
          maskCtx.imageSmoothingQuality = 'high';
          maskCtx.filter = 'blur(6px)';
          maskCtx.drawImage(smallCanvas, 0, 0, width, height);
          maskCtx.restore();

          // Face gating: keep only mask pixels that fall within a vertical
          // ellipse anchored on a detected face. People whose face isn't
          // visible (e.g. someone walking past with their back to camera)
          // get dropped into the background.
          if (faceDetector) {
            let faces = [];
            try {
              const fres = faceDetector.detectForVideo(video, ts);
              faces = (fres && fres.detections) || [];
            } catch (_) { /* ignore detector hiccups */ }

            gateCtx.clearRect(0, 0, width, height);
            if (faces.length > 0) {
              gateCtx.fillStyle = 'white';
              for (const det of faces) {
                const bb = det.boundingBox;
                if (!bb) continue;
                // bbox can come in normalized (0..1) or pixel coords depending on build;
                // detect & normalize.
                let fx = bb.originX, fy = bb.originY, fw = bb.width, fh = bb.height;
                if (fw <= 1.5 && fh <= 1.5) { // normalized
                  fx *= width; fy *= height; fw *= width; fh *= height;
                }
                const cx = fx + fw / 2;
                const faceTop = fy;
                // Person ellipse: centered horizontally on face, extends from
                // ~1 face-height above the face down ~9 face-heights, ~3 face-widths wide.
                const ellW = fw * 3.0;
                const ellH = fh * 10.0;
                const ellCx = cx;
                const ellCy = faceTop + ellH * 0.35; // face sits in upper third
                gateCtx.beginPath();
                gateCtx.ellipse(ellCx, ellCy, ellW / 2, ellH / 2, 0, 0, Math.PI * 2);
                gateCtx.fill();
              }
              // Soft feather on the gate so edges blend.
              gateCtx.save();
              gateCtx.globalCompositeOperation = 'source-over';
              gateCtx.filter = 'blur(20px)';
              gateCtx.drawImage(gateCanvas, 0, 0);
              gateCtx.restore();
              gateCtx.filter = 'none';

              // Intersect mask with gate: maskCanvas ∩= gateCanvas
              maskCtx.globalCompositeOperation = 'destination-in';
              maskCtx.drawImage(gateCanvas, 0, 0, width, height);
              maskCtx.globalCompositeOperation = 'source-over';
            } else {
              // No faces detected → wipe the mask entirely (everything becomes background).
              maskCtx.clearRect(0, 0, width, height);
            }
          }

          // Temporal smoothing: smoothed = prev*0.6 + new*0.4 (sweet spot between
          // flicker reduction and motion lag).
          if (!hasPrevMask) {
            prevMaskCtx.clearRect(0, 0, width, height);
            prevMaskCtx.drawImage(maskCanvas, 0, 0);
            hasPrevMask = true;
          } else {
            smoothMaskCtx.globalCompositeOperation = 'source-over';
            smoothMaskCtx.clearRect(0, 0, width, height);
            smoothMaskCtx.globalAlpha = 0.6;
            smoothMaskCtx.drawImage(prevMaskCanvas, 0, 0);
            smoothMaskCtx.globalCompositeOperation = 'lighter';
            smoothMaskCtx.globalAlpha = 0.4;
            smoothMaskCtx.drawImage(maskCanvas, 0, 0);
            smoothMaskCtx.globalAlpha = 1.0;
            smoothMaskCtx.globalCompositeOperation = 'source-over';

            // Use smoothed as the mask, and save it for next frame's prev.
            maskCtx.clearRect(0, 0, width, height);
            maskCtx.drawImage(smoothMaskCanvas, 0, 0);

            prevMaskCtx.clearRect(0, 0, width, height);
            prevMaskCtx.drawImage(smoothMaskCanvas, 0, 0);
          }

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

    // Small canvas for the model's native-resolution mask (e.g. 256x256).
    const smallMaskCanvas = document.createElement('canvas');
    const smallCanvasCtx = smallMaskCanvas.getContext('2d');

    // Buffers for temporal smoothing.
    const prevMaskCanvas = document.createElement('canvas');
    prevMaskCanvas.width = width;
    prevMaskCanvas.height = height;
    const prevMaskCtx = prevMaskCanvas.getContext('2d');
    const smoothMaskCanvas = document.createElement('canvas');
    smoothMaskCanvas.width = width;
    smoothMaskCanvas.height = height;
    const smoothMaskCtx = smoothMaskCanvas.getContext('2d');
    let hasPrevMask = false;

    // Buffer for face-gate ellipses.
    const gateCanvas = document.createElement('canvas');
    gateCanvas.width = width;
    gateCanvas.height = height;
    const gateCtx = gateCanvas.getContext('2d');

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
