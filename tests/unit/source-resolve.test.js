/**
 * 播放页 → 视频地址：苹果 CMS 的 player_aaaa.url 是这一集，页面别处明文出现的下一集地址不能抢先。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { direct } from '../../src/lib/server/sources/resolve.js';

test('direct：player_aaaa 的这一集优先于页面里明文的下一集（xfdmneo）', () => {
  const html = `<script>var player_aaaa={"encrypt":0,"url":"https:\\/\\/v.example.com\\/d\\/ep10.mp4",`
    + `"url_next":"https:\\/\\/v.example.com\\/d\\/ep11.mp4","nid":10}</script>`
    + `<script>w.postMessage({"next":"https://v.example.com/d/ep11.mp4"})</script>`;
  assert.deepEqual(direct(html), { url: 'https://v.example.com/d/ep10.mp4' });
});

test('direct：player_aaaa 给的是播放器页时，仍从源码里找直链', () => {
  const html = `<script>var player_aaaa={"encrypt":0,"url":"https:\\/\\/p.example.com\\/play?id=1"}</script>`
    + `<video src="https://v.example.com/a/index.m3u8"></video>`;
  assert.deepEqual(direct(html), { url: 'https://v.example.com/a/index.m3u8' });
});

test('direct：没有直链时把播放器页交给下一跳', () => {
  const html = `<script>var player_aaaa={"encrypt":0,"url":"https:\\/\\/p.example.com\\/play?id=1"}</script>`;
  assert.deepEqual(direct(html), { page: 'https://p.example.com/play?id=1' });
});
