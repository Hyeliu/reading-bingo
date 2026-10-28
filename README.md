# 阅读大挑战 BINGO · 云端部署说明

这个文件夹就是可以直接部署的完整应用：一个 Node 服务 + 几个静态文件，**零依赖**（不用 `npm install` 装任何东西）。

---

## 一、部署到 Render（免费，推荐）

### 第 1 步：把代码放到 GitHub

1. 打开 <https://github.com/new>，仓库名随便取（比如 `reading-bingo`），设为 **Public**，点 Create repository
2. 在新仓库页面点 **uploading an existing file**
3. 把**这个文件夹里的所有文件**拖进去（不含 `node_modules`，本来也没有）
4. 点 **Commit changes**

> 没有 GitHub 账号就先注册一个，免费。国内访问 GitHub 偶尔慢，多试两次。

### 第 2 步：在 Render 上开服务

1. 打开 <https://render.com>，用 GitHub 账号登录（不用绑卡）
2. 点 **New +** → **Blueprint**
3. 选中刚才那个仓库 → Render 会自动读到 `render.yaml` → 点 **Apply**
4. 等 1–2 分钟，拿到地址：`https://reading-bingo-xxxx.onrender.com`

这个地址**固定不变**，发微信群、写在教案里都行。

### 第 3 步（可选）：让数据不丢

免费实例的硬盘是临时的，**重新部署会清空服务器上的数据**。我做了兜底：小朋友下次打开页面时，自己设备上的记录会自动补回服务器。

想彻底稳妥，就在 Render 里给服务加一块 Disk：
- 服务页 → **Disks** → Add Disk，大小 1GB（约 $7/月），Mount Path 填 `/var/data`
- 再到 **Environment** 加一条 `DATA_DIR` = `/var/data`
- 保存后会重新部署

---

## 二、部署到自己的服务器 / Docker

```bash
docker build -t reading-bingo .
docker run -d -p 8080:8080 -v /你的目录:/data --name bingo reading-bingo
```

然后访问 `http://服务器地址:8080`。

环境变量：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | 4321 | 监听端口 |
| `DATA_DIR` | `./data` | 数据目录（`state.json` 和 `photos/`） |

---

## 三、云上少了什么

| 功能 | 本机 | 云上 |
| --- | --- | --- |
| 多人同步、老师后台、书架墙、导出 | ✅ | ✅ |
| 拍照**存照片** | ✅ | ✅ |
| 拍照**自动认书名** | ✅ | ❌ 自动隐藏按钮 |

认字用的是 macOS 自带的文字识别（Vision 框架），云服务器上没有。要保留的话，得把 `server.js` 里 `/api/ocr` 换成云厂商的 OCR 接口（阿里云、腾讯云都有免费额度，几百行以内能接）。

---

## 四、免费实例的小脾气

- **15 分钟没人访问会休眠**，下一个打开的人要等 30 秒左右（页面转圈是正常的）
- 白天上课期间一直有人用，就不会睡
- 想让它一直醒着，可以用免费的 uptime 监控（比如 UptimeRobot）每 10 分钟 ping 一下 `/healthz`

---

## 五、把老班级搬上来

1. 在老地方（本机）打开 `/#/admin` → 「备份 / 迁移」→ **导出（含照片）**，得到一个 JSON
2. 在云上的 `/#/admin` → 「备份 / 迁移」→ **导入备份…** → 选那个 JSON
3. 座位、书单、任务、照片都会搬过来；小朋友用新地址打开，点回自己的座位即可

## 六、怎么更新

改完代码（在本机的 `bingo-web` 目录改，别改这里）→ 运行 `bash cloud-build.sh` 重新生成 → 把 `cloud-deploy` 里的文件重新拖到 GitHub → Render 会自动重新部署。
