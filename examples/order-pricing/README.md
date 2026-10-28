# 订单计价集成参考案例

这是仓库维护的业务场景示例，不代表外部客户采用或生产环境验证。使用独立消费者项目安装真实 tarball 后，验证 Node 文件 API 的 ESM 产物与 CLI 打包执行。不会上传订单或连接外部服务。

## 复现

在仓库根目录使用 Node.js 24、pnpm 10.34.6：

```sh
pnpm build
pnpm test:package
consumer=$(mktemp -d)
cp examples/order-pricing/* "$consumer/"
npm install --prefix "$consumer" "$PWD/artifacts/script-vm-next-0.2.0-beta.1.tgz" --no-save --package-lock=false --ignore-scripts --registry=https://registry.npmjs.org
npm --prefix "$consumer" run verify
# 检查完结果后清理独立消费者目录：
rm -rf "$consumer"
```

升级版本后，请将 tarball 文件名替换为 `test:package` 输出的实际路径。Beta 发布后，也可在该独立目录安装一个**明确版本**，例如 `script-vm-next@0.2.0-beta.1`；只有确认 npm 上存在该版本后才使用注册表安装。

## 验收内容

`pricing.mjs` 使用整数分计算商品合计、会员九折（优惠向下取整）和运费：折后金额满 10000 分免运费，空订单不收运费，其余收 500 分。五组固定预期覆盖空订单、会员优惠、运费临界点及多商品取整；四组异常输入覆盖负价格、无效数量、小数价格和金额溢出。

`verify.mjs` 在 `auto` 和 `full` 下验证 ESM 输出，并同时与原生执行和固定预期比较；再通过 CLI 打包带本地导入的入口，在独立 Node 进程执行产物并检查 JSON 结果。临时产物在结束后删除。

当前模块管线按输出格式选择输入语法：本案例的 ESM 源码使用 `format: esm`。将同一输入直接指定为 `cjs` 或 `iife` 会报 `SYNTAX_ERROR`；不将跨模块格式转换列为本案例的通过项。

这些规则仅用于集成演示，不是完整电商计价模块：未实现订单结构校验、税费、汇率、退款或支付。未测量生产吞吐、混淆强度或浏览器业务接入；生成代码本身不是安全沙箱。

实际项目接入后，请按[集成与反馈说明](../../docs/integrations.md)提供脱敏复现和环境信息。
