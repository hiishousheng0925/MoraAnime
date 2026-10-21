/**
 * 超分辨率（Anime4K，WebGPU）—— 和 Kazumi 播放器的「效率档 / 质量档」同一类东西：
 * 用显卡实时把动画画面放大、锐化、去模糊。
 *
 *   效率档 = Anime4K Mode A（一遍）    质量档 = Mode A+A（两遍，更吃显卡）
 *
 * 只用 anime4k-webgpu 的处理管线，渲染循环自己写：它自带的 render() 没有停止的办法，
 * 关掉 / 换档 / 换集时管线会叠在同一个 <video> 上越开越多。这里每次 start 返回 stop，停了就销毁 GPU 设备。
 *
 * 前提（缺一个就不可用，调用方据此把按钮置灰）：
 *   · WebGPU：只在 https（或 localhost）下有 —— 走 https://<机器名>.<tailnet>.ts.net 访问
 *   · 视频帧可读：跨站且不带 CORS 的视频不能拷进显卡（SecurityError）。hls.js 走 MSE 天然可读；
 *     直连 mp4 的站（7sefun / AGE）要换成本站中转的地址（见 sources/stream.js 的 mp4 代理）
 */
export const srSupported = () => typeof navigator !== 'undefined' && !!navigator.gpu && globalThis.isSecureContext;

const SHADER = /* wgsl */ `
@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var tex: texture_2d<f32>;
struct VO { @builtin(position) pos: vec4f, @location(0) uv: vec2f };
@vertex fn vs(@builtin(vertex_index) i: u32) -> VO {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var o: VO;
  o.pos = vec4f(p[i], 0.0, 1.0);
  o.uv = vec2f((p[i].x + 1.0) * 0.5, 1.0 - (p[i].y + 1.0) * 0.5);
  return o;
}
@fragment fn fs(v: VO) -> @location(0) vec4f { return textureSample(tex, samp, v.uv); }`;

/**
 * @param {HTMLVideoElement} video
 * @param {HTMLCanvasElement} canvas  尺寸由调用方按显示大小 × devicePixelRatio 设好
 * @param {'fast'|'quality'} mode
 * @param {(e: unknown) => void} [onError]  运行期出错（某一帧抛异常 / 显卡设备丢失）时调一次，此时已自行停下、销毁设备
 * @returns {Promise<() => void>} stop（启动时第一帧就失败则直接 reject，不走 onError）
 */
export async function startSuperRes(video, canvas, mode, onError) {
  const A4K = await import('anime4k-webgpu');
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new Error('没有可用的显卡');
  const device = await adapter.requestDevice();
  const ctx = canvas.getContext('webgpu');
  const format = navigator.gpu.getPreferredCanvasFormat();
  ctx.configure({ device, format, alphaMode: 'opaque' });

  const module = device.createShaderModule({ code: SHADER });
  const pipeline = device.createRenderPipeline({ layout: 'auto',
    vertex: { module, entryPoint: 'vs' }, fragment: { module, entryPoint: 'fs', targets: [{ format }] },
    primitive: { topology: 'triangle-list' } });
  const sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
  const Preset = mode === 'quality' ? A4K.ModeAA : A4K.ModeA;

  // 输入纹理和 Anime4K 管线跟着片源分辨率走：hls.js 自动切码率（720p ↔ 1080p）后尺寸会变，
  // 旧纹理再拷新帧进去会报错，所以每帧比一次，变了就按新尺寸重建（设备和渲染管线不动，播放不断）。
  // 预设没有销毁接口，旧的中间纹理留给 GC，停下时 device.destroy() 一并释放
  let w = 0, h = 0, input = null, preset = null, bind = null;
  const build = () => {
    input?.destroy();
    w = video.videoWidth; h = video.videoHeight;
    input = device.createTexture({ size: [w, h, 1], format: 'rgba16float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT });
    preset = new Preset({ device, inputTexture: input,
      nativeDimensions: { width: w, height: h }, targetDimensions: { width: canvas.width, height: canvas.height } });
    bind = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
      { binding: 0, resource: sampler },
      { binding: 1, resource: preset.getOutputTexture().createView() }] });
  };
  const draw = () => {
    // 换片源 / 切码率的间隙 videoWidth 会短暂为 0：这一帧跳过，画面停在上一帧
    if (!video.videoWidth || !video.videoHeight) return;
    if (video.videoWidth !== w || video.videoHeight !== h) build();
    device.queue.copyExternalImageToTexture({ source: video }, { texture: input }, [w, h]);
    const enc = device.createCommandEncoder();
    preset.pass(enc);
    const pass = enc.beginRenderPass({ colorAttachments: [{ view: ctx.getCurrentTexture().createView(),
      clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: 'clear', storeOp: 'store' }] });
    pass.setPipeline(pipeline); pass.setBindGroup(0, bind); pass.draw(3); pass.end();
    device.queue.submit([enc.finish()]);
  };

  let stopped = false, handle = 0;
  const stop = () => {
    if (stopped) return;
    stopped = true; video.cancelVideoFrameCallback?.(handle); device.destroy();
  };
  // 运行期的错误没有调用方能接住（在 requestVideoFrameCallback 里抛），只能停下后回调通知，
  // 否则调用方仍以为超分在画、<video> 一直藏着 → 画面冻住
  const fail = (e) => { if (stopped) return; stop(); onError?.(e); };
  // 驱动崩溃 / 显卡被占走 / 系统休眠都会丢设备；自己 destroy 的也会触发（reason = 'destroyed'），那时 stopped 已是 true
  device.lost.then((info) => fail(new Error(`显卡设备丢失：${info.message || info.reason}`)));

  const frame = () => {
    if (stopped) return;
    try { draw(); } catch (e) { fail(e); return; }
    handle = video.requestVideoFrameCallback(frame);
  };
  // 先画一帧：暂停中开超分也立刻看得到效果；之后每出一帧画一次。第一帧的错误直接抛给调用方
  try { draw(); } catch (e) { stop(); throw e; }
  handle = video.requestVideoFrameCallback(frame);
  return stop;
}
