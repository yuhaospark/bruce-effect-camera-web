// WebGLRenderer — guided-filter mask refinement + gaussian-blurred background +
// final composite, all on GPU. Replaces the Canvas 2D path in inject.js.
//
// Inputs per frame:
//   - video element (the raw camera, size W x H)
//   - low-res person-confidence mask as a Float32Array (mw x mh), 0..1 (1 = person)
//   - background image (HTMLImageElement) when mode === 'image'
// Config: { mode: 'none'|'blur'|'image', blurRadius: 1..50 }
//
// Output: this.canvas (HTMLCanvasElement) — feed to captureStream(30).

window.BruceWebGLRenderer = class WebGLRenderer {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.canvas = document.createElement('canvas');
    this.canvas.width = width;
    this.canvas.height = height;
    const gl = this.canvas.getContext('webgl2', { premultipliedAlpha: false, antialias: false });
    if (!gl) throw new Error('WebGL2 not available');
    this.gl = gl;

    // --- Shaders ---
    const VS = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main(){
  v_uv = a_pos * 0.5 + 0.5;
  // Flip Y so textures (uploaded with UNPACK_FLIP_Y=true) render upright.
  gl_Position = vec4(a_pos.x, a_pos.y, 0.0, 1.0);
}`;

    // Joint-bilateral upsample of low-res mask using video luminance as guide.
    // For each output pixel, sample a small neighborhood in the low-res mask and
    // weight by (spatial gaussian) * (similarity in guide luminance).
    const REFINE_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 fragColor;
uniform sampler2D u_video;
uniform sampler2D u_mask;     // low-res, R channel = person confidence 0..1
uniform vec2 u_videoSize;
uniform vec2 u_maskSize;

float luma(vec3 c){ return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

void main(){
  vec3 cCenter = texture(u_video, v_uv).rgb;
  float yc = luma(cCenter);

  // Sample in a 5x5 neighborhood in mask UV space.
  vec2 maskTexel = 1.0 / u_maskSize;
  vec2 videoTexel = 1.0 / u_videoSize;

  float sumW = 0.0;
  float sumM = 0.0;

  // Range sigma in luminance.
  const float sigmaR = 0.10;
  // Spatial sigma in texel units (in mask space).
  const float sigmaS = 1.5;

  for (int dy = -2; dy <= 2; dy++) {
    for (int dx = -2; dx <= 2; dx++) {
      vec2 o = vec2(float(dx), float(dy));
      vec2 muv = v_uv + o * maskTexel;
      float m = texture(u_mask, muv).r;

      // Sample the guide (video) at the same approximate location for similarity weighting.
      vec3 cN = texture(u_video, muv).rgb;
      float yn = luma(cN);

      float ws = exp(-0.5 * dot(o, o) / (sigmaS * sigmaS));
      float wr = exp(-0.5 * (yn - yc) * (yn - yc) / (sigmaR * sigmaR));
      float w = ws * wr;

      sumW += w;
      sumM += w * m;
    }
  }

  float refined = sumW > 0.0 ? sumM / sumW : 0.0;

  // Smoothstep remap to clean up uncertain regions; keeps a soft alpha ramp.
  refined = smoothstep(0.20, 0.80, refined);
  fragColor = vec4(refined, refined, refined, refined);
}`;

    // Separable Gaussian blur, used twice for background blur.
    const BLUR_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 fragColor;
uniform sampler2D u_src;
uniform vec2 u_texel;     // 1/size
uniform vec2 u_dir;       // (1,0) or (0,1)
uniform float u_radius;   // pixels
void main(){
  // Sample at 2x stride exploiting linear filtering -> ~17-tap effective.
  // Number of samples scales with radius.
  float r = max(1.0, u_radius);
  int N = int(min(16.0, r));
  float sumW = 0.0;
  vec3 sumC = vec3(0.0);
  float sigma = r * 0.5;
  for (int i = -16; i <= 16; i++) {
    if (i < -N || i > N) continue;
    float f = float(i);
    float w = exp(-0.5 * f * f / (sigma * sigma));
    vec2 off = u_dir * u_texel * f;
    sumC += texture(u_src, v_uv + off).rgb * w;
    sumW += w;
  }
  fragColor = vec4(sumC / sumW, 1.0);
}`;

    // Final composite: lerp(background, video, mask).
    const COMP_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 fragColor;
uniform sampler2D u_video;
uniform sampler2D u_bg;
uniform sampler2D u_mask;
void main(){
  vec3 v = texture(u_video, v_uv).rgb;
  vec3 b = texture(u_bg, v_uv).rgb;
  float a = texture(u_mask, v_uv).r;
  fragColor = vec4(mix(b, v, a), 1.0);
}`;

    // Pass-through (when mode === 'none').
    const PASS_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 fragColor;
uniform sampler2D u_src;
void main(){ fragColor = texture(u_src, v_uv); }`;

    this.progRefine = this._program(VS, REFINE_FS);
    this.progBlur   = this._program(VS, BLUR_FS);
    this.progComp   = this._program(VS, COMP_FS);
    this.progPass   = this._program(VS, PASS_FS);

    // Quad VBO.
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(this.progRefine, 'a_pos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    // Textures.
    this.texVideo = this._tex(gl.LINEAR);
    this.texMaskLo = this._tex(gl.LINEAR);
    this.texMaskHi = this._tex(gl.LINEAR);   // refined mask, full res
    this.texBg = this._tex(gl.LINEAR);       // background buffer
    this.texBlurTmp = this._tex(gl.LINEAR);  // ping-pong for separable blur

    // Allocate FBO targets at full res.
    this._resize(this.texMaskHi, width, height, gl.RGBA8);
    this._resize(this.texBg,     width, height, gl.RGBA8);
    this._resize(this.texBlurTmp,width, height, gl.RGBA8);

    this.fbo = gl.createFramebuffer();
  }

  _tex(filter) {
    const gl = this.gl;
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  _resize(tex, w, h, internalFormat) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  }

  _program(vsSrc, fsSrc) {
    const gl = this.gl;
    const compile = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        const err = gl.getShaderInfoLog(s);
        gl.deleteShader(s);
        throw new Error('Shader compile: ' + err + '\n' + src);
      }
      return s;
    };
    const vs = compile(gl.VERTEX_SHADER, vsSrc);
    const fs = compile(gl.FRAGMENT_SHADER, fsSrc);
    const p = gl.createProgram();
    gl.attachShader(p, vs);
    gl.attachShader(p, fs);
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      throw new Error('Program link: ' + gl.getProgramInfoLog(p));
    }
    gl.deleteShader(vs); gl.deleteShader(fs);
    return p;
  }

  _bindFBO(tex) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.viewport(0, 0, this.width, this.height);
  }

  /// Upload video frame and low-res mask, run pipeline, draw to canvas.
  /// maskData: Float32Array length mw*mh, mw/mh: ints, 1 = person.
  /// bgImage: HTMLImageElement or null
  render(videoEl, maskData, mw, mh, config, bgImage) {
    const gl = this.gl;
    const W = this.width, H = this.height;

    // 1. Upload video frame.
    gl.bindTexture(gl.TEXTURE_2D, this.texVideo);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, videoEl);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);

    const mode = config.mode || 'none';

    // Fast path: no effect.
    if (mode === 'none') {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, W, H);
      gl.useProgram(this.progPass);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.texVideo);
      gl.uniform1i(gl.getUniformLocation(this.progPass, 'u_src'), 0);
      gl.bindVertexArray(this.vao);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      return;
    }

    // 2. Upload low-res mask as a single-channel float, repacked into RGBA8 (use R channel).
    //    WebGL2 supports R8 internal format with red channel — use that.
    if (this._mwh !== mw * 100000 + mh) {
      gl.bindTexture(gl.TEXTURE_2D, this.texMaskLo);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, mw, mh, 0, gl.RED, gl.UNSIGNED_BYTE, null);
      this._mwh = mw * 100000 + mh;
      this._maskU8 = new Uint8Array(mw * mh);
    }
    // Convert Float32 0..1 → Uint8 0..255.
    const u8 = this._maskU8;
    for (let i = 0; i < maskData.length; i++) {
      const v = maskData[i];
      u8[i] = v <= 0 ? 0 : v >= 1 ? 255 : (v * 255) | 0;
    }
    gl.bindTexture(gl.TEXTURE_2D, this.texMaskLo);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, mw, mh, gl.RED, gl.UNSIGNED_BYTE, u8);

    // 3. Refine pass: joint-bilateral upsample mask using video as guide.
    this._bindFBO(this.texMaskHi);
    gl.useProgram(this.progRefine);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texVideo);
    gl.uniform1i(gl.getUniformLocation(this.progRefine, 'u_video'), 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.texMaskLo);
    gl.uniform1i(gl.getUniformLocation(this.progRefine, 'u_mask'), 1);
    gl.uniform2f(gl.getUniformLocation(this.progRefine, 'u_videoSize'), W, H);
    gl.uniform2f(gl.getUniformLocation(this.progRefine, 'u_maskSize'), mw, mh);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    // 4. Build background texture (texBg).
    if (mode === 'blur') {
      // Horizontal blur of video → texBlurTmp
      this._bindFBO(this.texBlurTmp);
      gl.useProgram(this.progBlur);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.texVideo);
      gl.uniform1i(gl.getUniformLocation(this.progBlur, 'u_src'), 0);
      gl.uniform2f(gl.getUniformLocation(this.progBlur, 'u_texel'), 1.0/W, 1.0/H);
      gl.uniform2f(gl.getUniformLocation(this.progBlur, 'u_dir'), 1, 0);
      gl.uniform1f(gl.getUniformLocation(this.progBlur, 'u_radius'), config.blurRadius || 15);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      // Vertical blur → texBg
      this._bindFBO(this.texBg);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.texBlurTmp);
      gl.uniform2f(gl.getUniformLocation(this.progBlur, 'u_dir'), 0, 1);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    } else if (mode === 'image' && bgImage) {
      // Upload bg image to texBg (cover-fit done in shader-free way: pre-fit on a 2D canvas)
      this._uploadBgImage(bgImage);
    } else {
      // Fallback: copy video to texBg.
      this._copyVideoToBg();
    }

    // 5. Composite to canvas.
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, W, H);
    gl.useProgram(this.progComp);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texVideo);
    gl.uniform1i(gl.getUniformLocation(this.progComp, 'u_video'), 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.texBg);
    gl.uniform1i(gl.getUniformLocation(this.progComp, 'u_bg'), 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.texMaskHi);
    gl.uniform1i(gl.getUniformLocation(this.progComp, 'u_mask'), 2);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  _uploadBgImage(img) {
    if (this._bgImgRef === img && this._bgImgW === img.naturalWidth) return;
    this._bgImgRef = img;
    this._bgImgW = img.naturalWidth;

    // cover-fit on a CPU canvas before uploading.
    const c = document.createElement('canvas');
    c.width = this.width; c.height = this.height;
    const ctx = c.getContext('2d');
    const ir = img.naturalWidth / img.naturalHeight;
    const cr = this.width / this.height;
    let dw, dh, dx, dy;
    if (ir > cr) { dh = this.height; dw = this.height * ir; dx = (this.width - dw)/2; dy = 0; }
    else         { dw = this.width;  dh = this.width / ir; dx = 0; dy = (this.height - dh)/2; }
    ctx.drawImage(img, dx, dy, dw, dh);

    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.texBg);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, c);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  }

  _copyVideoToBg() {
    const gl = this.gl;
    this._bindFBO(this.texBg);
    gl.useProgram(this.progPass);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texVideo);
    gl.uniform1i(gl.getUniformLocation(this.progPass, 'u_src'), 0);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
};
