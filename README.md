# agent-kit

多 agent 共用的规则 / 技能 / 子代理 / hook / 记忆套件（私有，P0 开发中）。设计与计划见团队内部文档。

## 自动更新

`agent-kit` 自带更新机制(验签 / 完整性校验 / 冒烟 / 原子切换 `current` / 坏版本回退),不依赖手动 `npm i -g`。更新后的版本装在 `~/.local/share/agent-kit/`,之后每次启动都由启动器按「`current` 更高且同 major、完整树校验通过」转发到它。

- **前台命令**:在交互终端里跑任意前台命令(非 CI)后,到期(24 小时)会在后台拉起 `__update --background` 检查并安装新版本,不阻塞命令。
- **pi 钩子也会转发与调度**:`rsi poke` / `rsi hint` / `__rsi --background` 在执行自身逻辑前同样按上述判据转发到 `current`(任何一环对不上就静默用自己,不输出、不写盘);`rsi poke` 在满足条件时(未设 `KIT_AUTO_UPDATE=0`、非 CI、`[update] auto_install` 为真、距上次检查满 24 小时、受控 tmp 目录已存在)顺带拉起一次后台更新;钩子自身不联网、不写盘、不输出(转发到 `current` 时,输出来自 `current` 里的同一钩子)。
- **关闭**:环境变量 `KIT_AUTO_UPDATE=0`,或 `~/.config/agent-kit/config.toml` 里 `[update] auto_install = false`。
- **存量 pi 用户迁移**:升级后在终端跑一次任意 agent-kit 命令(如 `agent-kit --version`),让前台备好受控 tmp 目录;否则 poke 不会调度更新。`agent-kit doctor` 的 D01 会在缺失时给出提示。
- **首次接入**:引导版本(npm 全局安装的那份)必须已包含本逻辑,需要手动 `npm i -g @chovizzz/agent-kit` 一次,之后全自动。
