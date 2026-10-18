# Stremio Prowlarr + Real-Debrid 聚合插件

Node.js 编写的 Stremio 第三方插件：

- **Prowlarr** 做后端索引器聚合（插件本身零爬虫），检索各 BT 站磁力资源
- **Real-Debrid** 做云端秒播：命中 RD 缓存的 hash 直接出直链，未命中回退裸磁力流
- **可选成人分类 (18+)**：配置页勾选后，Stremio 目录出现"成人影片"，走 Prowlarr 中已配置的成人索引器（如 Sukebei，分类号 6000）

## 文件结构

```
├── package.json          # 依赖清单（stremio-addon-sdk / express / axios）
├── manifest.js           # Manifest 构建器（按配置动态声明成人目录）
├── addon.js              # 核心：catalog handler + stream handler + 配置编解码
├── server.js             # Express 入口：配置页 / SDK 路由 / RD 直链代理
├── lib/
│   ├── prowlarr.js       # Prowlarr API 客户端（搜索 + infoHash 提取 + 缓存）
│   └── realdebrid.js     # RD 适配层（instantAvailability + 磁力解析）
├── public/
│   └── configure.html    # Web 配置页（含成人开关）
├── Dockerfile
└── docker-compose.yml    # 本地联调：Prowlarr + 插件一键起
```

## 工作原理

### 目录（Catalog）

用户在 Stremio 打开插件目录并搜索 → 插件转发给 Prowlarr `/api/v1/search`：

| 目录 | Prowlarr 分类号 |
|---|---|
| Prowlarr 电影搜索 | 2000 (Movies) |
| Prowlarr 剧集搜索 | 5000 (TV) |
| 成人影片 (18+)（勾选才有） | 6000 (XXX) |

每条 release 变成一个 meta 条目，id 用 `rd:<infoHash>`（成人内容在 Cinemeta 无元数据，用 hash 做 id 可在 stream 阶段精确回溯）。

### 播放流（Stream）

1. id 是 `rd:<hash>`（本插件目录点入）→ 直接对该 hash 建流
2. id 是 IMDb id（官方目录点入）→ 查 Cinemeta 拿标题/年份 → 搜 Prowlarr（剧集自动拼 `SxxEyy`）
3. 配了 RD Key 时，先批量查 `torrents/instantAvailability`：
   - **云端已有** → `addMagnet → selectFiles → info` 换直链，流地址走本插件 `/proxy/<config>/<hash>/<idx>` 代理（代带 RD 鉴权 302 跳到真直链）
   - **云端没有** → 回退为 `infoHash` 裸磁力流，Stremio 内置 BT 引擎可播

## 本地联调

前提：Docker Desktop 已安装。

```bash
cd stremio-prowlarr-rd-addon

# 1. 一键起 Prowlarr + 插件
docker compose up -d

# 2. 配置 Prowlarr
#    打开 http://localhost:9696
#    Settings → General → 记下 API Key
#    Settings → Indexers → Add：
#      - 常规站：1337x / RARBG 替代源 / TorrentGalaxy 等（Categories 勾 2000/5000）
#      - 成人站：Sukebei Nyaa（Categories 勾 6000 XXX）——需先在 Prowlarr 的
#        Settings → Tags 里建一个 adult tag 并加到该索引器，方便管理

# 3. 不用 Docker 直接跑插件也行（调试用）：
npm install
npm start

# 4. 生成安装链接
#    打开 http://localhost:7000/configure，填入地址 + Key，按需勾选成人开关
#    点"生成安装链接" → 点 stremio:// 链接一键安装
```

## 部署到 GCP e2-micro 免费层（推荐，无需 Oracle）

GCP 永远免费层：1 台 e2-micro（美区）+ 30GB 标准盘，足够跑全套。

1. 注册 [cloud.google.com](https://cloud.google.com)（绑卡验证，送 $300/90 天试用金）
2. 建 VM：`Compute Engine → VM instances → Create`
   - **区域必须是 us-west1 / us-central1 / us-east1**（只有这三区的 e2-micro 免费）
   - 机型：`e2-micro`，系统 Ubuntu 22.04
   - 磁盘：**Standard persistent disk，30GB**（ balanced/SSD 不免费）
   - 勾选 **Allow HTTP traffic / Allow HTTPS traffic**
3. 建好后点 VM 行的 **SSH**（浏览器终端），粘贴一条命令：

```bash
curl -fsSL https://raw.githubusercontent.com/kevinhfwang/stremio-prowlarr-rd-addon/main/deploy/gcp-setup.sh | bash -s -- stremio.你的域名.com prowlarr.你的域名.com
```

脚本自动完成：2GB swap → 装 Docker → 拉代码 → 启动 Prowlarr + 插件 + Caddy（自动 HTTPS）。

4. 去 DNS 加两条 A 记录指向 VM 外部 IP（`stremio.域名`、`prowlarr.域名`）
5. 打开 `https://prowlarr.你的域名` 配置索引器，再到 `https://stremio.你的域名/configure` 生成安装链接

**免费层避坑**：
- VM 停机时静态 IP 会计费，要么不建静态 IP，要么保证机器常开
- 免费出站流量 1GB/月；本插件流量极小（RD 直链是播放器直连，不过服务器）
- 建议 Billing → Budgets 建个 $1 告警

## 部署到 Oracle Cloud 免费 VPS（ARM 架构也支持）

```bash
# 本地构建并打包（也可在 VPS 上直接 build）
docker build -t stremio-prowlarr-rd .
docker save stremio-prowlarr-rd | gzip > stremio-addon.tar.gz
scp stremio-addon.tar.gz ubuntu@<你的VPS_IP>:~/

# VPS 上
gunzip -c stremio-addon.tar.gz | docker load
docker run -d --name stremio-addon --restart unless-stopped -p 7000:7000 stremio-prowlarr-rd
```

然后需要 HTTPS（Stremio 手机端要求 addon 地址是 https 或局域网 http）：

```bash
# 推荐 Caddy，自动申请 Let's Encrypt，两行配置即可
sudo apt install caddy
echo 'stremio.你的域名.com

reverse_proxy 127.0.0.1:7000' | sudo tee /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

最后打开 `https://stremio.你的域名.com/configure` 生成安装链接（配置页里的 Prowlarr 地址此时要填公网可达的地址，建议同样用 Caddy 反代 Prowlarr 并加 Basic Auth 或仅内网隧道）。

## 安全提示

- 配置（含 Prowlarr/RD Key）以 base64url 编码放在安装 URL 里——**这是编码不是加密**，只防君子不防小人。插件只被自己家人用没问题；要公开分享请先加一层访问控制。
- RD 直链代理只带你自己的 RD 账户鉴权，别人拿到安装链接等于用你的 RD 流量。
