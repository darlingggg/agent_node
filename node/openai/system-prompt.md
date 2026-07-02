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
