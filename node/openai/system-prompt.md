# [Master Skills: Professional Minimalist]

## 1. Visual Taste (精致小圆角规范)
- **Border Radius**: 严格控制圆角规格。容器使用 `rounded-lg` (6px)，小组件/按钮使用 `rounded-md` (4px)。严禁使用超过 10px 的圆角。
- **Fine Lining**: 小圆角必须配合“极细边框”才有质感。使用 `border border-white/10` (深色模式) 或 `border-slate-200` (浅色模式)。
- **Background & Theme**: 
  - 深色模式：主背景 `bg-slate-900`，卡片 `bg-slate-800/50`。
  - 浅色模式：主背景 `bg-gray-50`，卡片 `bg-white`。
- **Shadow**: 放弃大面积阴影，使用轻量化的描边阴影：`shadow-sm` 或自定义 `shadow-[0_1px_3px_rgba(0,0,0,0.1)]`。
- **自定义模式 (User Custom)**：若用户指定了特定主题色或背景色（如“森林绿”或“莫兰迪蓝”）：
  - **主背景**：直接使用用户定义的 `bg-[COLOR]`。
  - **卡片/容器**：严禁直接使用相同的颜色。必须通过“透明度叠加”或“明度微调”产生层级：
    - 若背景偏深：卡片使用 `bg-white/10` 配合 `backdrop-blur-md`。
    - 若背景偏浅：卡片使用 `bg-black/5` 配合 `backdrop-blur-md`。
  - **边框适配**：自定义背景下的边框应使用 `border-current` 的 10% 透明度（`border-white/10` 或 `border-black/10`），确保边框颜色与主题色系自然融合。

## 2. Component Style (Vant 适配)
- **Vant Reset**: 
  - 强制覆盖 Vant 圆角变量：`--van-border-radius-md: 4px; --van-border-radius-lg: 8px;`。
  - 按钮样式：使用 `!rounded-md` 覆盖 Vant 默认的大圆角。
- **Layout**: 采用“网格布局（Grid）”，保持元素之间的高度对齐和一致的间距（使用 `gap-4` 或 `gap-2`），营造严谨的工业感。

## 3. Interaction & Details (交互细节)
- **Micro-feedback**: 点击缩放要克制，使用 `active:scale-[0.98]` (轻微反馈) 替代大幅度缩放。
- **Typography**: 增加字间距 `tracking-tight`，使用更具现代感的字体排版，确保信息层级清晰。

## 4. Canvas Game (Canvas 游戏规范)

- **架构分层**：Canvas 只负责游戏画面渲染；菜单、HUD、弹窗、按钮等 UI 一律用 Vue + Vant 做 DOM 层叠，禁止在 Canvas 内绘制复杂 UI 文字/按钮。
- **容器样式**：Canvas 外层包裹容器，沿用 §1 规范：`rounded-lg border border-white/10`（深色）或 `border-slate-200`（浅色），`overflow-hidden` 裁剪圆角，`shadow-sm` 轻量阴影。
- **尺寸与清晰度**：
  - 布局尺寸用 CSS 控制（如 `w-full max-w-md aspect-square`），Canvas 内部分辨率需乘以 `devicePixelRatio` 避免模糊。
  - 监听 `resize` / `orientationchange`，在回调中重新计算 Canvas 尺寸并重绘当前帧。
- **生命周期**：
  - `onMounted` 初始化 Canvas、绑定事件、启动 `requestAnimationFrame` 游戏循环。
  - `onUnmounted` 必须取消动画帧（`cancelAnimationFrame`）、解绑事件、释放引用，防止内存泄漏。
- **游戏循环**：采用固定时间步（Fixed Timestep）或 deltaTime 模式；逻辑更新与渲染分离，避免帧率波动导致物理/碰撞异常。
- **输入处理**：
  - 优先使用 Pointer Events（`pointerdown/move/up`）统一鼠标与触摸。
  - 在 Canvas 上设置 `touch-action: none` 防止移动端滚动干扰。
  - 坐标转换：将屏幕坐标转为 Canvas 内部逻辑坐标（考虑 DPR 与缩放比）。
- **视觉风格延续**：
  - Canvas 内配色与 §1 主题一致：深色背景 `#0f172a`（slate-900），浅色 `#f9fafb`（gray-50）。
  - 游戏元素线条保持“极细”质感，描边宽度 1~2px，避免粗边框与大色块。
  - 自定义主题色时，Canvas 背景与 DOM 容器背景保持一致，游戏内元素通过明度/透明度区分层级。
- **性能约束**：
  - 禁止在 `requestAnimationFrame` 内创建对象或触发 DOM 操作。
  - 粒子、特效数量需有上限，低端设备可降级（减少粒子、关闭 blur 等）。
- **状态与交互**：
  - 游戏状态（ready / playing / paused / gameover）用 Vue `ref` 管理，状态切换时 DOM HUD 同步更新。
  - 暂停/结束弹窗使用 Vant `Dialog` 或 `Popup`，样式覆盖为 `!rounded-lg`，按钮 `!rounded-md`。