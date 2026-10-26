# 怎么让它出现在 DSH 插件市场里

两条不同的路，一条比一条难。先把机制说清楚，再给可执行的步骤。

## 一、社区目录（4,000+ 条，装完就能搜到）

市场的社区区读的是一个 npm 包 `dsh-plugin-catalog`，它是「全量目录」的快照，不是人工逐条审核的清单。
也就是说社区收录的门槛是「能被索引到」，而不是「被谁批准」。

所以顺序是

1. `npm publish` 一个公开包（包名建议就叫 `dsh-chatlock`）。
2. `package.json` 里必须有 `dsh` 字段（本仓库已经有 `dsh.bundle.patch` 与 `dsh.client`），
   `keywords` 里带 `dsh-plugin`——索引器靠这两个信号认出「这是一个 DSH 插件」而不是普通包。
3. 等目录刷新（或者给 `dsh-plugin-catalog` 提 PR 加一条）。

发布前先确认名字没被占

```bash
npm view dsh-chatlock version
```

有输出就是被占了，换个名字（比如 `dsh-chatlock-pro`、`@你的scope/dsh-chatlock`），
然后把 `package.json` 的 `name` 一起改掉——插件的 loader id 是 `chatlock`，和包名解耦，改名不影响已装用户。

## 二、精选清单（人工策展，装机必备 / 崔添翼精选 / 自研 / 观察区）

精选是 `iasiv5/dsh-m` 仓库里的 `registry.json`，人工审。给它提 PR 就是上精选的唯一入口。

一条合格的条目长这样（照抄本仓库 `docs/registry-entry.json` 再改）

```json
{
  "id": "dsh-chatlock",
  "name": "DSH Chatlock",
  "description": "给会话上密码锁，并把目录整体加密成保险箱；锁定后磁盘上只有密文。",
  "category": "watchlist",
  "tags": ["隐私", "加密", "锁"],
  "verified": ["0.2.1-rc.3"],
  "source": "npm",
  "npm": "dsh-chatlock",
  "github": "xevil3301/dsh-chatlock",
  "homepage": "https://github.com/xevil3301/dsh-chatlock"
}
```

几个字段的规矩

- `id` 必须和包名一致（或能被唯一识别）
- `verified` 只写你**真的在这台机器上跑过**的 DSH 版本。这是给用户看的兼容承诺，不是装饰
- `category` 用哪个区，先看现有条目怎么分的，别自己发明
- `description` 控制在两行内，说清「给谁解决什么」，不写营销词

## 三、这条路上的两个硬前提

1. **仓库得是公开的**。私有仓库市场拿不到 `package.json`，条目会被判为无效。
2. **GitHub 要能访问到**。市场会去 `raw.githubusercontent.com` 拉 `package.json` 校验 npm/github 字段是否对得上。

## 四、发版节奏

市场的「可更新」是按 npm 最新版算的，不是按 git tag。所以

```bash
npm version patch        # 0.1.0 → 0.1.1
git push --follow-tags
npm publish
```

三次都做完，市场里才会亮「可更新」。只推 git 不发 npm，用户那边永远是旧版。
