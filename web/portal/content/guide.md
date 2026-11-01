## 常见安装问题

### `dsh: command not found`

说明 dsh 没有安装到当前终端可访问的位置。可以直接用 `npx` 启动，不需要全局安装：

```bash
npx --yes @deepseek-ai/dsh@0.2.1-rc.5 --profile trend-coach --port 3939 --no-open
```

如果希望后续命令更短，再按官方文档把 dsh 安装到全局。

### 插件安装时报 peer 版本不匹配

插件要求 dsh **精确为 0.2.1-rc.5**。升级或降级 dsh 后重新安装插件：

```bash
npx --yes @deepseek-ai/dsh@0.2.1-rc.5 --profile trend-coach --port 3939 --no-open
dsh plugin --profile trend-coach add -w ./dsh-plugin-trend-coach-0.1.0.tgz
```

### 提示 profile 不存在

先用目标 profile 启动一次 dsh，让它创建配置目录，再安装插件：

```bash
npx --yes @deepseek-ai/dsh@0.2.1-rc.5 --profile trend-coach --port 3939 --no-open
```

### 端口被占用

把 `--port 3939` 换成其他未占用端口，例如 `--port 4040`，并同步修改访问地址。

### 安装后侧边栏没有出现「趋势伴学」

- 确认安装的插件版本与当前 dsh 版本匹配。
- 重启 dsh 客户端，而不是只刷新浏览器。
- 检查 `dsh plugin --profile trend-coach list` 是否能看到插件。
- 查看 dsh 启动日志中是否有插件激活失败的提示。

### 设备授权页面打不开或提示设备码无效

- 设备码有时效，过期后回到客户端重新点击「设备登录」。
- 授权页地址以客户端展示为准，不要手动拼接到其他域名。
- 用本站注册的账号登录授权页即可；管理员创建的账号同样可用。
- 授权成功后回到客户端等待几秒，面板会自动刷新登录状态。

### Web UI 打不开

Web UI 需要额外安装：

```bash
dsh plugin --profile trend-coach add @deepseek-ai/dsh-web-app
```

安装后重启 dsh，再按启动日志中的地址访问。

### 视频无法播放

- 加密 HLS 需要浏览器支持 MSE；优先使用最新版 Chrome、Edge 或 Safari。
- 确认视频服务支持 HTTP Range 请求，否则无法拖动进度。
- 如果只有部分设备异常，先尝试清除浏览器缓存或换一个浏览器验证。

## 还需要帮助？

记录以下信息再联系管理员，可以显著缩短排查时间：

1. 操作系统与 Node.js 版本（`node -v`）。
2. dsh 与插件版本。
3. 出错的完整命令与提示文字。
4. 问题发生在安装、授权、检索还是播放阶段。
