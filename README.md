# Bruce Effect Camera (Chrome 插件)

网页摄像头虚拟背景：模糊 / 自定义背景图，零依赖安装。

通过劫持 `navigator.mediaDevices.getUserMedia`，对 Google Meet、飞书 web、Discord、Whereby、腾讯会议 web 等所有调用网页摄像头的页面生效。

## 安装

1. 打开 Chrome / Edge / Arc，地址栏访问 `chrome://extensions`
2. 右上角开启「开发者模式 / Developer mode」
3. 点「加载已解压的扩展程序 / Load unpacked」
4. 选择本文件夹：`~/projects/bruce-effect-camera-web/`
5. 工具栏上能看到蓝色方块图标即安装成功

## 使用

1. 点工具栏上的扩展图标 → 选择背景模式（无 / 模糊 / 图片）→ 调参
2. **刷新摄像头所在的网页**（或重新加入会议），效果即生效
3. 调整滑块/换图后无需刷新，下次 `getUserMedia` 调用自动用新配置

## 兼容性

| 平台 | 支持 |
|---|---|
| Google Meet | ✅ |
| 飞书 web | ✅ |
| Discord (web) | ✅ |
| Whereby | ✅ |
| 腾讯会议 web | ✅ |
| Zoom web | ✅ |
| Chrome 桌面客户端的 native app | ❌（这些是 native，不在浏览器里） |

## 技术

- Manifest V3
- MediaPipe Tasks Vision (Selfie Segmenter, GPU delegate, ~250KB 模型)
- Canvas 2D 合成（背景模糊用 CSS filter，背景图用 cover-fit）
- 配置走 `chrome.storage.local`，content script 转发到主 world 的 inject.js

## 文件

```
manifest.json           扩展元数据
content.js              content script（隔离 world，桥接配置）
inject.js               主 world 代码：劫持 getUserMedia + 跑分割合成
popup.html / popup.js   工具栏弹窗 UI
vendor/                 MediaPipe wasm + tflite 模型（~18MB，主要是 wasm）
icons/icon128.png
```

## 已知限制

- 第一次调用摄像头时要加载 MediaPipe（约 0.5-2s），表现为前几帧是原始画面
- 模型是 256x256，对小脸/远景的边缘抠图不太干净
- 用 `canvas.captureStream(30)` 输出固定 30fps，不随显示器刷新率自适应
- 部分严苛的 CSP 网站可能拒绝注入 `<script>` 标签 —— 暂未遇到，等遇到再修
