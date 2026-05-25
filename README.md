# Bruce Effect Camera — Chrome 插件

网页摄像头虚拟背景：**背景模糊** / **自定义背景图**，零依赖安装。

通过劫持 `navigator.mediaDevices.getUserMedia`，对 Google Meet、飞书 web、Discord、Whereby、腾讯会议 web、Zoom web 等所有调用网页摄像头的页面生效。

---

## 为什么有这个插件

macOS 上"虚拟摄像头" 的现代正解（CMIOExtension）需要付费 Apple Developer Program（$99/年），且对系统签名机制要求很严。Chrome 插件这条路：

- **免费、零签名**
- **不动系统**
- **任何 Chromium 系浏览器 + 任何网页**都生效
- 缺点：**只在浏览器里**有效，桌面客户端（Zoom.app、腾讯会议.app）用不上

姊妹项目 [`bruce-effect-camera`](../bruce-effect-camera/) 是 macOS native app 版本（已封存，等付费后激活），覆盖桌面客户端。两者一起用即可全场景覆盖。

---

## 安装

1. 打开 Chrome / Edge / Arc，地址栏访问 `chrome://extensions`
2. 右上角开启「开发者模式 / Developer mode」
3. 点「加载已解压的扩展程序 / Load unpacked」
4. 选择本文件夹
5. 工具栏上能看到蓝色 B 图标即安装成功

## 使用

1. 点工具栏的 B 图标 → 选择模式（无 / 模糊 / 图片）→ 调参
2. **刷新摄像头所在的网页**（或重新加入会议），效果生效
3. 调整滑块 / 换图后无需刷新，下次 `getUserMedia` 调用自动应用新配置

---

## 兼容性

| 平台 | 支持 |
|---|---|
| Google Meet | ✅ |
| 飞书 web | ✅ |
| Discord (web) | ✅ |
| Whereby | ✅ |
| 腾讯会议 web | ✅ |
| Zoom web | ✅ |
| webcamtests.com（debug 用） | ✅ |
| Zoom / 腾讯会议 / 飞书的 **桌面客户端** | ❌（不是 web） |

---

## 技术栈

- Manifest V3
- MediaPipe Tasks Vision (selfie_segmenter, GPU delegate, ~250KB 模型)
- Canvas 2D 合成（CSS filter blur + alpha mask + temporal smoothing）
- 配置走 `chrome.storage.local`，content script 转发到主 world 的 inject.js

## 文件布局

```
manifest.json           扩展元数据
content.js              content script（隔离 world，桥接 storage ↔ inject）
inject.js               主 world 代码：劫持 getUserMedia + 跑分割合成
popup.html / popup.js   工具栏弹窗 UI
vendor/                 MediaPipe wasm + tflite 模型
icons/                  几何 B 图标 16/32/48/128
```

---

## 已知限制

- 第一次调用摄像头时要加载 MediaPipe（约 0.5–2s），表现为前几帧是原始画面
- 模型 256x256 是 selfie segmenter，对头发/小细节边缘抠图不够干净
- `canvas.captureStream(30)` 固定 30fps，不随显示器刷新率自适应
- 极少数严苛 CSP 的站点可能拒绝注入 `<script>` —— 暂未遇到，遇到再修

## 调参注释（如果以后想自己改边缘表现）

`inject.js` 里的关键值（基于多轮实测得到的稳定组合）：

| 参数 | 当前值 | 含义 |
|---|---|---|
| smoothstep 区间 | `0.2..0.8` | mask 渐变带宽度，区间窄 = 边缘硬；区间宽 = halo 明显 |
| feather blur | `6px` | mask alpha 通道羽化半径 |
| 时间平滑 prev 权重 | `0.6` | 上一帧 mask 占比，越高越稳但越拖影 |

调过的其它路：WebGL guided filter（两次都没调通，已回滚）、形态学 erosion（会啃头发，已回滚）、加大羽化到 12px 伪装 halo（整体变糊，已回滚）。git log 有完整迭代记录。

## License

MIT
