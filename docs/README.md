# Documentation

- [中文文档](zh-CN/)
  - [部署](zh-CN/deployment.md)
  - [游戏与前端接口](zh-CN/interfaces.md)
  - [测试](zh-CN/testing.md)
- [English documentation](en/)
  - [Deployment](en/deployment.md)
  - [Game and frontend interfaces](en/interfaces.md)
  - [Testing](en/testing.md)

The platform is a TypeScript/SQLite server. Each game is an independent git
submodule under `src/games/`; its browser module and card assets are copied into
the gitignored `web/games/` directory by `npm run sync-games`.
