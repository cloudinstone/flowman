# Flowman - Google Flow Batch Downloader

A lightweight Chrome Extension (Manifest V3) for Google Flow, focused on **batch downloading 1080p / 4K upscaled videos** one by one without manual babysitting. Also supports `720p` videos and `1K / 2K / 4K` images.

[中文说明](#中文说明)

## Features

- **1080p / 4K Upscaled Video Queue**: Triggers Flow's upscaling and waits for each download to finish before starting the next, avoiding concurrent upscale failures.
- **Zero-Disruption Background Trigger**: Calls Flow's internal download pipeline directly—no hover menus popping up and no forced page scrolling.
- **Native Side Panel**: Browse thumbnails, select items (`Option`/`Alt + Click` on tiles also works), track progress, and retry failed downloads.

## Install & Use

1. Clone this repo (`git clone https://github.com/cloudinstone/flowman.git`).
2. Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, and select the `flowman` folder.
3. Open a Google Flow project (`https://flow.google.com/project/...`) and click the **Flowman** toolbar icon to open the Side Panel.
4. Pick **Videos** (`1080p` / `4K` / `720p`) or **Images** (`1K` / `2K` / `4K`), select items, and click **Start download**.

> Tip: Turn off Chrome's *"Ask where to save each file before downloading"* so batch downloads save automatically.

---

## 中文说明

一个轻量的 Google Flow Chrome 扩展（Manifest V3），主打 **1080p / 4K 超分（Upscaled）视频的串行批量下载**——自动排队触发超分并等待每个文件下载完成，无需守在页面逐个点击；同时支持 `720p` 原画视频与 `1K / 2K / 4K` 图片批量下载。

### 主要特性

- **1080p / 4K 超分队列**：严格串行触发并等待下载完成，避免同时发起多个超分任务导致失败。
- **静默触发不打扰**：直接调用 Flow 内部下载服务，不弹出 hover 菜单，也不抢占页面滚动。
- **原生侧边栏管理**：支持缩略图列表勾选（也支持在 Flow 页面按住 `Option`/`Alt + 点击` 卡片选中）、实时进度与失败重试。

### 安装与使用

1. 克隆仓库：`git clone https://github.com/cloudinstone/flowman.git`
2. 打开 `chrome://extensions`，开启右上角 **开发者模式**，点击 **加载已解压的扩展程序**，选择 `flowman` 目录。
3. 打开任意 Google Flow 项目页面（`https://flow.google.com/project/...`），点击工具栏 **Flowman** 图标打开侧边栏。
4. 选择 **Videos**（`1080p` / `4K` / `720p`）或 **Images**（`1K` / `2K` / `4K`），勾选需要下载的条目并点击 **Start download**。

> 提示：建议在 Chrome 设置中关闭「下载前询问每个文件的保存位置」，避免批量下载时频繁弹出保存窗口。
