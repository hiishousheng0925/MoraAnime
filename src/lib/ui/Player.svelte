<script>
  /**
   * 观看页的播放器（2026-10-19 改版，替掉浏览器自带的控制条）。
   * 自带控制条的问题：样式朴素、倍速藏在「⋮」里、没有上一集 / 下一集、不记倍速和音量。
   *   · 控制条：⏮ ▶ ⏭ · 时间 · 超分 · 倍速 · 音量 · 画中画 · 全屏（跳过片头主人说不需要）；进度条带缓冲段、悬停显示时间
   *   · 手机（<640px，2026-10 UI 大改）：只留 ▶ ⏭ · 时间 · ⋯ · 全屏，上一集 / 倍速 / 超分 / 静音收进「⋯」；
   *     全部不折行（原来 390px 时时间折两行、「超分」「倍速」挤成竖排单字）；进度条贴底边，控制条隐藏时留细进度线
   *   · 鼠标 3 秒不动、正在播放时自动隐藏控制条和光标；双击全屏
   *   · 快捷键：空格 / K 暂停，← → 5 秒，↑ ↓ 音量，F 全屏，M 静音，N / P 下一集 / 上一集
   *   · 手机：点一下显示 / 隐藏控制条，双击左右两侧 ±10 秒
   *   · 播完倒数 5 秒自动下一集，可取消
   *   · 倍速和音量记在 localStorage（单人站的个人偏好，丢了也只是回到默认）
     *
   * m3u8 能用 hls.js 就用 hls.js，原生 HLS 只给没有 MSE 的 iPhone Safari 兜底 —— 新版桌面 Chrome 的
   * canPlayType 也回 "maybe"，交给原生播放器直接 error 4（DM84 一集都放不出来，2026-10-19 实测）。
   */
  import Play from 'phosphor-svelte/lib/Play';
  import Pause from 'phosphor-svelte/lib/Pause';
  import SkipBack from 'phosphor-svelte/lib/SkipBack';
  import SkipForward from 'phosphor-svelte/lib/SkipForward';
  import SpeakerHigh from 'phosphor-svelte/lib/SpeakerHigh';
  import SpeakerX from 'phosphor-svelte/lib/SpeakerX';
  import CornersOut from 'phosphor-svelte/lib/CornersOut';
  import CornersIn from 'phosphor-svelte/lib/CornersIn';
  import PictureInPicture from 'phosphor-svelte/lib/PictureInPicture';
  import Camera from 'phosphor-svelte/lib/Camera';
  import Heart from 'phosphor-svelte/lib/Heart';
  import DotsThree from 'phosphor-svelte/lib/DotsThree';
  import ArrowLeft from 'phosphor-svelte/lib/ArrowLeft';
  import { untrack } from 'svelte';
  import { media } from '$lib/media.svelte.js';
  import { srSupported, startSuperRes } from './superres.js';

  /** srSrc：开超分时换用的同源地址（直连 mp4 跨站读不了画面）；不给就用 src */
  /**
   * epLabel：全屏时顶栏显示「番名 [第 N 集]」（主人 2026-10-19，参考 Kazumi）
   * liked / onlike：右上角爱心 = 标记「在看」
   * onshot(blob|null, t)：右上角截图。blob = 画面本身（不含控制条）；null = 画面跨站读不了（直连 mp4），交给服务端截
   * httpsUrl：http 访问时超分不可用，菜单里给一个跳到 https 地址的链接
   * onback：手机上左上角的返回（页面标题区在手机上不放返回键）；immersive（手机横屏铺满）时也留着，并和全屏一样写番名
   * pending：还没有 src 时盖在画面上的内容（观看页传封面模糊底 + 转圈 + 「解析中」）
   */
  let { src, srSrc = null, title = '', epLabel = '', liked = false, onlike, onshot, httpsUrl = null, onback = null, immersive = false,
        hasPrev = false, hasNext = false, onprev, onnext, onprogress, onfail, onmeta, pending } = $props();

  const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
  const store = {
    get: (k, d) => { try { const v = localStorage.getItem(`j-anime.player.${k}`); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set: (k, v) => { try { localStorage.setItem(`j-anime.player.${k}`, JSON.stringify(v)); } catch { /* 隐私模式 */ } }
  };

  let box = $state(), video = $state();
  let paused = $state(true), time = $state(0), dur = $state(0), buffered = $state(0), waiting = $state(false);
  let speed = $state(store.get('speed', 1)), volume = $state(store.get('volume', 1)), muted = $state(false);
  let full = $state(false), shown = $state(true), hover = $state(null);
  /** 打开的菜单：'speed' | 'sr'（桌面各挂在自己的按钮上）| 'more'（手机的「⋯」，倍速 / 超分也从这里进） */
  let menu = $state(null);
  let countdown = $state(0);
  let hideTimer, cdTimer;
  const bare = $derived(!(shown || paused));

  /**
   * 超分辨率（见 superres.js）：关闭 / 效率档 / 质量档，选择记在本机，缺省关闭。
   * 只有 https 访问时才可用（WebGPU 的要求），http 下按钮置灰并提示。
   */
  const SR_OPTS = [['off', '关闭'], ['fast', '效率档'], ['quality', '质量档']];
  let sr = $state(store.get('sr', 'off')), srOk = $state(false), srErr = $state(''), canvas = $state(), boxW = $state(0), boxH = $state(0), ready = $state(false);
  $effect(() => { srOk = srSupported(); });
  const srOn = $derived(sr !== 'off' && srOk && !srErr);
  /** 真正交给 <video> 的地址：开超分且有同源地址时换过去 */
  const playSrc = $derived(srOn && srSrc ? srSrc : src);
  const setSr = (v) => { sr = v; srErr = ''; menu = null; store.set('sr', v); };
  const srName = $derived(SR_OPTS.find(([k]) => k === sr)?.[1]);

  const fmt = (s) => {
    if (!Number.isFinite(s)) return '0:00';
    s = Math.floor(s); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
    return (h ? `${h}:${String(m).padStart(2, '0')}` : `${m}`) + `:${String(x).padStart(2, '0')}`;
  };

  // 换源：挂 hls.js 或直接给 src。先存下元素：换集时 <video> 先被卸载，bind:this 变 null
  // 同一集里切超分会换地址（直连 mp4 ↔ 中转），记下进度，换完接着播
  let resumeAt = 0, lastEp = null;
  $effect(() => {
    const v = video, s = playSrc;
    if (!v || !s) return;
    // 用 time（上一个地址最后的播放位置）而不是 v.currentTime：走到这里时旧地址已经被清理函数卸掉、归零了
    resumeAt = lastEp === src ? untrack(() => time) : 0; lastEp = src;
    time = 0; dur = 0; buffered = 0; ready = false;
    let hls, dead = false;
    countdown = 0; clearInterval(cdTimer);
    (async () => {
      if (!/\.m3u8/i.test(s)) { v.src = s; return; }
      const { default: Hls } = await import('hls.js');
      if (dead) return;
      if (!Hls.isSupported()) { if (v.canPlayType('application/vnd.apple.mpegurl')) v.src = s; else onfail?.(); return; }
      hls = new Hls();
      hls.on(Hls.Events.ERROR, (_, d) => { if (d.fatal) { console.warn('[片源] hls 播放失败', d.type, d.details, d.response?.code ?? ''); onfail?.(); } });
      hls.loadSource(s);
      hls.attachMedia(v);
    })();
    return () => { dead = true; hls?.destroy(); v.removeAttribute('src'); v.load(); };
  });
  // 换源会把 playbackRate 重置成 defaultPlaybackRate（下一集回到 1x）—— 两个都设，loadedmetadata 时再补一次
  const applyRate = () => { if (video) { video.defaultPlaybackRate = speed; video.playbackRate = speed; } };
  $effect(() => { applyRate(); store.set('speed', speed); });
  $effect(() => { if (video) { video.volume = volume; video.muted = muted; store.set('volume', volume); } });

  function poke() {
    shown = true; clearTimeout(hideTimer);
    hideTimer = setTimeout(() => { if (!paused && !menu) shown = false; }, 3000);
  }
  const toggle = () => { if (!video) return; video.paused ? video.play().catch(() => {}) : video.pause(); poke(); };
  const seek = (t) => { if (video && dur) { video.currentTime = Math.max(0, Math.min(dur - 0.5, t)); poke(); } };
  const toggleFull = () => (document.fullscreenElement ? document.exitFullscreen() : box?.requestFullscreen?.())?.catch?.(() => {});
  const pip = () => (document.pictureInPictureElement ? document.exitPictureInPicture() : video?.requestPictureInPicture?.())?.catch?.(() => {});
  const openMenu = (m) => { menu = menu === m ? null : m; poke(); };

  function ontime() {
    time = video.currentTime;
    if (video.buffered.length) buffered = video.buffered.end(video.buffered.length - 1);
    if (dur) onprogress?.(time / dur);
  }
  function onended() {
    if (!hasNext) return;
    countdown = 5; clearInterval(cdTimer);
    cdTimer = setInterval(() => { if (--countdown <= 0) { clearInterval(cdTimer); onnext?.(); } }, 1000);
  }
  const cancelNext = () => { clearInterval(cdTimer); countdown = 0; };

  function onkey(e) {
    if (e.key === 'Escape' && menu) { menu = null; return; }
    if (!video || e.target.closest?.('input, textarea, select, [contenteditable]') || e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key.toLowerCase();
    const act = {
      ' ': toggle, k: toggle, arrowleft: () => seek(time - 5), arrowright: () => seek(time + 5),
      arrowup: () => { volume = Math.min(1, +(volume + 0.1).toFixed(2)); muted = false; poke(); },
      arrowdown: () => { volume = Math.max(0, +(volume - 0.1).toFixed(2)); poke(); },
      f: toggleFull, m: () => { muted = !muted; poke(); },
      n: () => hasNext && onnext?.(), p: () => hasPrev && onprev?.()
    }[k];
    if (act) { e.preventDefault(); act(); }
  }

  /**
   * 点画面。单击等 250ms 看有没有第二下 —— 不等的话双击会先暂停再播放闪一下。
   *   鼠标：单击暂停 / 播放，双击全屏
   *   触屏：单击显隐控制条；双击左 / 右三分之一 ±10 秒，中间双击全屏
   * 开着菜单时点画面只关菜单
   */
  let tapTimer = null;
  function onTap(e) {
    if (menu) { menu = null; poke(); return; }
    const r = box.getBoundingClientRect(), x = (e.clientX - r.left) / r.width, touch = e.pointerType !== 'mouse';
    if (tapTimer) {
      clearTimeout(tapTimer); tapTimer = null;
      if (touch && x < 0.33) seek(time - 10); else if (touch && x > 0.67) seek(time + 10); else toggleFull();
      return;
    }
    tapTimer = setTimeout(() => { tapTimer = null; if (touch) { shown ? (shown = false) : poke(); } else toggle(); }, 250);
  }
  function onBar(e) {
    const r = e.currentTarget.getBoundingClientRect();
    hover = { x: e.clientX - r.left, t: Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * dur };
  }
  /** 开着超分且画面就绪：按播放器大小重建管线（全屏 / 窗口大小变了也重建，目标分辨率跟着变） */
  $effect(() => {
    const v = video, c = canvas, mode = sr, on = srOn, ok = ready, bw = boxW, bh = boxH;
    if (!on || !ok || !v || !c || !v.videoWidth || !bw) return;
    const ar = v.videoWidth / v.videoHeight, dpr = Math.min(devicePixelRatio || 1, 2);
    const dw = Math.min(bw, bh * ar), dh = dw / ar;
    c.style.width = `${dw}px`; c.style.height = `${dh}px`;
    // 目标分辨率：不低于片源（窗口模式下播放器只有 940px 宽，按显示尺寸算等于把 1080p 缩小，超分白做），
    // 全屏时跟着屏幕走；封顶 4K —— 再大显卡白算，屏幕也显示不出来
    const tw = Math.min(3840, Math.max(dw * dpr, v.videoWidth));
    c.width = Math.round(tw); c.height = Math.round(tw / ar);
    let stop = null, dead = false;
    startSuperRes(v, c, mode).then((s) => { if (dead) s(); else stop = s; })
      .catch((e) => { console.warn('[超分] 启动失败', e); srErr = String(e?.message ?? e); });
    return () => { dead = true; stop?.(); };
  });

  /**
   * 截当前画面。只截画面，不截控制条：
   *   开着超分 → 直接导出超分后的 canvas（比原片清晰，这是比 Kazumi 多的一点 —— 它截的是解码后的原始帧）
   *   没开     → 把 video 当前帧按原分辨率画到离屏 canvas
   * 跨站且不带 CORS 的视频（直连 mp4）画上去会「污染」canvas、导不出来，返回 null 让服务端用 ffmpeg 截
   */
  let shooting = $state(false), note = $state(''), flash = $state(false);
  /** 播放器里自己的提示：全屏时右下角的全局 toast 被全屏层盖住看不见 */
  const say = (t) => { note = t; setTimeout(() => { if (note === t) note = ''; }, 2200); };
  async function shoot() {
    if (!video || shooting || !onshot) return;
    shooting = true;
    const t = video.currentTime;
    try {
      let blob = null;
      try {
        let c = srOn && ready ? canvas : null;
        if (!c) {
          c = document.createElement('canvas');
          c.width = video.videoWidth; c.height = video.videoHeight;
          c.getContext('2d').drawImage(video, 0, 0);
        }
        blob = await new Promise((r) => c.toBlob(r, 'image/png'));
      } catch { blob = null; }   // SecurityError：canvas 被跨站视频污染
      flash = true; setTimeout(() => (flash = false), 180);
      const r = await onshot(blob, t);
      say(r ? '截图已保存' : '截图没保存');
    } finally { shooting = false; }
  }

  const BTN = 'tap grid h-9 w-9 shrink-0 place-items-center rounded-lg text-white/90 transition hover:bg-white/10 disabled:opacity-30';
  const POP = 'absolute bottom-full right-0 z-10 mb-2 overflow-hidden rounded-xl border border-white/15 bg-black/90 py-1 text-white shadow-2xl backdrop-blur';
  const ITEM = 'flex w-full items-center gap-3 whitespace-nowrap px-4 py-1.5 text-left text-[12px] hover:bg-white/10 disabled:opacity-30';
</script>

<svelte:window onkeydown={onkey} />
<svelte:document onfullscreenchange={() => (full = !!document.fullscreenElement)} />

{#snippet speedList()}
  {#each SPEEDS.toReversed() as s (s)}
    <button onclick={() => { speed = s; menu = null; }}
            class="{ITEM} tabular-nums {speed === s ? 'text-accent' : ''}">{s}x</button>
  {/each}
{/snippet}
{#snippet srList()}
  {#if srOk}
    {#each SR_OPTS as [k, l] (k)}
      <button onclick={() => setSr(k)} class="{ITEM} {sr === k ? 'text-accent' : ''}">{l}</button>
    {/each}
  {:else}
    <div class="w-56 px-3 py-2 text-[12px] leading-relaxed text-white/80">
      超分要用 https 地址打开
      {#if httpsUrl}<a href={httpsUrl} class="mt-1.5 block rounded-md bg-accent px-2.5 py-1.5 text-center font-medium text-on-accent">切到 https 地址</a>{/if}
    </div>
  {/if}
{/snippet}

<div bind:this={box} bind:clientWidth={boxW} bind:clientHeight={boxH} role="region" aria-label="播放器 {title}"
     class="group/p relative h-full w-full overflow-hidden bg-black {bare ? 'cursor-none' : ''}"
     onpointermove={poke}>
  <!-- svelte-ignore a11y_media_has_caption -->
  <video bind:this={video} autoplay playsinline class="h-full w-full {srOn && ready ? 'opacity-0' : ''}"
         onplay={() => { paused = false; poke(); }} onpause={() => { paused = true; shown = true; }}
         onwaiting={() => (waiting = true)} onplaying={() => (waiting = false)} oncanplay={() => (waiting = false)}
         ontimeupdate={ontime} onloadedmetadata={() => { dur = video.duration; applyRate(); if (resumeAt) video.currentTime = resumeAt; onmeta?.(video.videoHeight); }}
         onloadeddata={() => (ready = true)}
         ondurationchange={() => (dur = video.duration)} onended={onended} onerror={() => onfail?.()}></video>

  <!-- 超分画面：按视频比例铺在播放器中间（object-contain 的效果），分辨率 = 显示尺寸 × 设备像素比 -->
  <canvas bind:this={canvas} class="pointer-events-none absolute inset-0 m-auto {srOn && ready ? '' : 'hidden'}"></canvas>

  <!-- 点画面：桌面单击暂停 / 双击全屏；手机单击显隐、双击左右快退快进 -->
  <button type="button" aria-label={paused ? '播放' : '暂停'} class="absolute inset-0 cursor-[inherit]"
          onpointerup={onTap}></button>

  {#if !src}
    <div class="pointer-events-none absolute inset-0">{@render pending?.()}</div>
  {:else if waiting || !ready}
    <div class="pointer-events-none absolute inset-0 grid place-items-center">
      <span class="h-10 w-10 animate-spin rounded-full border-[3px] border-white/20 border-t-white/90"></span>
    </div>
  {/if}

  <!-- 顶栏：和底部控制条一起显隐。全屏时左边写番名和集数（窗口模式页面上已经有标题，不重复）；手机左边是返回 -->
  <div class="absolute inset-x-0 top-0 flex items-center gap-2 bg-gradient-to-b from-black/75 via-black/30 to-transparent px-2 pb-10 pt-1.5 text-white transition-opacity duration-200 sm:gap-3 sm:px-4 sm:pt-3
              {bare ? 'pointer-events-none opacity-0' : 'opacity-100'}">
    {#if onback && !full}<button class="{BTN} -ml-1 {immersive ? '' : 'sm:hidden'}" onclick={() => onback?.()} aria-label="返回详情"><ArrowLeft size={20} weight="bold" /></button>{/if}
    {#if full || immersive}
      <div class="min-w-0 truncate text-[15px] font-medium drop-shadow">{title}{#if epLabel}<span class="ml-2 text-white/80">[{epLabel}]</span>{/if}</div>
    {/if}
    <div class="ml-auto flex items-center gap-1">
      {#if onshot}
        <button class={BTN} onclick={shoot} disabled={shooting || !src} aria-label="截取当前画面" title="截取当前画面">
          <Camera size={20} weight={shooting ? 'fill' : 'regular'} />
        </button>
      {/if}
      {#if onlike}
        <button class={BTN} onclick={() => onlike?.()} aria-pressed={liked} aria-label={liked ? '在看（再点取消）' : '标记为在看'}
                title={liked ? '在看（再点取消）' : '标记为在看'}>
          <Heart size={20} weight={liked ? 'fill' : 'regular'} class={liked ? 'text-pink-400' : ''} />
        </button>
      {/if}
    </div>
  </div>
  {#if flash}<div class="pointer-events-none absolute inset-0 bg-white/40"></div>{/if}
  {#if note}
    <div class="pointer-events-none absolute right-4 top-14 rounded-lg bg-black/75 px-3 py-1.5 text-[13px] text-white">{note}</div>
  {/if}
  {#if countdown}
    <div class="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/60 text-white">
      <div class="text-sm">{countdown} 秒后播放下一集</div>
      <div class="flex gap-2">
        <button onclick={() => { cancelNext(); onnext?.(); }} class="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-on-accent">立即播放</button>
        <button onclick={cancelNext} class="rounded-lg border border-white/30 px-4 py-2 text-sm">取消</button>
      </div>
    </div>
  {/if}

  <!-- 控制条隐藏时（手机）底边留一道细进度线 -->
  <div class="pointer-events-none absolute inset-x-0 bottom-0 h-[2px] bg-white/15 transition-opacity duration-200 sm:hidden {bare ? '' : 'opacity-0'}">
    <div class="h-full bg-accent" style="width:{dur ? (time / dur) * 100 : 0}%"></div>
  </div>

  <!-- 底部：桌面「进度条 / 控制条」上下排；手机反过来，进度条贴底边 -->
  <div class="absolute inset-x-0 bottom-0 flex flex-col bg-gradient-to-t from-black/85 via-black/40 to-transparent px-1.5 pt-10 transition-opacity duration-200 sm:px-3 sm:pb-2
              {bare || !src ? 'pointer-events-none opacity-0' : 'opacity-100'}">
    <!-- 进度条：底下一层缓冲段，上面是 range（可拖、可键盘），悬停显示时间 -->
    <div class="relative h-4 max-sm:order-last max-sm:h-3.5" role="presentation" onpointermove={onBar} onpointerleave={() => (hover = null)}>
      <div class="pointer-events-none absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-white/20 max-sm:h-[3px]">
        <div class="absolute inset-y-0 left-0 rounded-full bg-white/30" style="width:{dur ? (buffered / dur) * 100 : 0}%"></div>
        <div class="absolute inset-y-0 left-0 rounded-full bg-accent" style="width:{dur ? (time / dur) * 100 : 0}%"></div>
      </div>
      <input type="range" min="0" max={dur || 0} step="0.1" value={time} aria-label="播放进度"
             oninput={(e) => seek(+e.currentTarget.value)} class="player-range absolute inset-0 h-full w-full cursor-pointer" />
      {#if hover && dur}
        <span class="pointer-events-none absolute -top-6 -translate-x-1/2 rounded bg-black/80 px-1.5 py-0.5 text-[11px] tabular-nums text-white"
              style="left:{hover.x}px">{fmt(hover.t)}</span>
      {/if}
    </div>

    <div class="flex items-center gap-0.5 whitespace-nowrap text-white sm:mt-1 sm:gap-1">
      <button class="{BTN} max-sm:hidden" onclick={() => onprev?.()} disabled={!hasPrev} aria-label="上一集"><SkipBack size={18} weight="fill" /></button>
      <button class={BTN} onclick={toggle} aria-label={paused ? '播放' : '暂停'}>
        {#if paused}<Play size={20} weight="fill" />{:else}<Pause size={20} weight="fill" />{/if}
      </button>
      <button class={BTN} onclick={() => onnext?.()} disabled={!hasNext} aria-label="下一集"><SkipForward size={18} weight="fill" /></button>
      <span data-time class="ml-1 whitespace-nowrap text-[12px] tabular-nums text-white/85">{fmt(time)} / {fmt(dur)}</span>

      <div class="ml-auto flex items-center gap-0.5 sm:gap-1">
        <div class="relative max-sm:hidden">
          <button onclick={() => openMenu('sr')} aria-expanded={menu === 'sr'} aria-label="超分辨率"
                  title={srErr ? `超分没开起来：${srErr}` : '超分辨率（Anime4K）'}
                  class="tap h-9 whitespace-nowrap rounded-lg px-2 text-[12px] font-medium hover:bg-white/10 {srOk ? '' : 'text-white/60'} {srOn ? 'text-accent' : ''}">
            超分{#if srOn} {srName}{:else if srErr}<span class="text-warm"> !</span>{/if}
          </button>
          {#if menu === 'sr' && !media.mobile}<div class={POP}>{@render srList()}</div>{/if}
        </div>
        <div class="relative max-sm:hidden">
          <button onclick={() => openMenu('speed')} aria-expanded={menu === 'speed'} aria-label="倍速"
                  class="tap h-9 whitespace-nowrap rounded-lg px-2 text-[12px] font-medium tabular-nums hover:bg-white/10">{speed === 1 ? '倍速' : `${speed}x`}</button>
          {#if menu === 'speed' && !media.mobile}<div class={POP}>{@render speedList()}</div>{/if}
        </div>
        <button class="{BTN} max-sm:hidden" onclick={() => (muted = !muted)} aria-label={muted ? '取消静音' : '静音'}>
          {#if muted || volume === 0}<SpeakerX size={18} />{:else}<SpeakerHigh size={18} />{/if}
        </button>
        <input type="range" min="0" max="1" step="0.05" bind:value={volume} oninput={() => (muted = false)} aria-label="音量"
               class="player-range hidden w-20 sm:block" />
        <button class="{BTN} max-sm:hidden" onclick={pip} aria-label="画中画"><PictureInPicture size={18} /></button>

        <!-- 手机：上一集 / 倍速 / 超分 / 静音都在「⋯」里（面板见下面，从播放器右侧盖上来） -->
        <div class="relative sm:hidden">
          <button class={BTN} onclick={() => openMenu('more')} aria-expanded={menu === 'more'} aria-label="更多播放选项"><DotsThree size={22} weight="bold" /></button>
        </div>
        <button class={BTN} onclick={toggleFull} aria-label={full ? '退出全屏' : '全屏'}>
          {#if full}<CornersIn size={18} />{:else}<CornersOut size={18} />{/if}
        </button>
      </div>
    </div>
  </div>
  <!-- 手机的「⋯」面板：盖在播放器右侧、跟着播放器高度自己滚 —— 竖屏播放器只有 220px 高，往上弹的菜单会被裁掉；
       放在播放器里面而不是底部抽屉，全屏时也看得见 -->
  {#if menu === 'more' && media.mobile}
    <div class="absolute inset-0 z-20 flex justify-end bg-black/45" role="presentation" onclick={(e) => { if (e.target === e.currentTarget) menu = null; }}>
      <div class="h-full w-[min(17rem,78%)] overflow-y-auto border-l border-white/10 bg-black/85 py-1.5 text-white backdrop-blur-md" role="menu" aria-label="更多播放选项">
        <button class={ITEM} onclick={() => { menu = null; onprev?.(); }} disabled={!hasPrev}><SkipBack size={16} weight="fill" />上一集</button>
        <button class={ITEM} onclick={() => (muted = !muted)}>
          {#if muted}<SpeakerX size={16} />取消静音{:else}<SpeakerHigh size={16} />静音{/if}
        </button>
        <div class="px-4 pb-1 pt-2 text-[11px] text-white/60">倍速</div>
        <div class="grid grid-cols-4 gap-1 px-3">
          {#each SPEEDS as s (s)}
            <button onclick={() => { speed = s; menu = null; }}
                    class="rounded-lg py-1.5 text-[12px] tabular-nums {speed === s ? 'bg-accent font-semibold text-on-accent' : 'bg-white/10'}">{s}x</button>
          {/each}
        </div>
        <div class="px-4 pb-1 pt-3 text-[11px] text-white/60">超分</div>
        {#if srOk}
          <div class="grid grid-cols-3 gap-1 px-3 pb-2">
            {#each SR_OPTS as [k, l] (k)}
              <button onclick={() => setSr(k)} class="rounded-lg py-1.5 text-[12px] {sr === k ? 'bg-accent font-semibold text-on-accent' : 'bg-white/10'}">{l}</button>
            {/each}
          </div>
        {:else}{@render srList()}{/if}
      </div>
    </div>
  {/if}
</div>

<style>
  /* range 本身透明，只留拖动的圆点；进度和缓冲段由下面那几层 div 画 */
  .player-range { appearance: none; background: transparent; }
  .player-range::-webkit-slider-runnable-track { height: 4px; background: transparent; }
  .player-range::-webkit-slider-thumb { appearance: none; margin-top: -4px; height: 12px; width: 12px; border-radius: 9999px; background: #fff; }
  .player-range::-moz-range-thumb { height: 12px; width: 12px; border: 0; border-radius: 9999px; background: #fff; }
  .player-range[aria-label='音量'] { height: 1rem; }
  .player-range[aria-label='音量']::-webkit-slider-runnable-track { background: rgb(255 255 255 / 0.3); border-radius: 9999px; }
</style>
