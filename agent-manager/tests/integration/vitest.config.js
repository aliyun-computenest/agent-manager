import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  test: {
    root: __dirname,
    include: ['suites/**/*.test.js'],
    globalSetup: ['./setup/global-setup.js'],
    setupFiles: ['./setup/test-env.js'],
    // 默认 60s；实例生命周期用例内部会用 it.setTimeout 覆盖
    testTimeout: 60_000,
    hookTimeout: 120_000,
    // 集成测试对同一测试库有数据写入，禁止并发
    fileParallelism: false,
    sequence: {
      concurrent: false,
      hooks: 'stack',
    },
    reporters: process.env.CI
      ? ['default', ['junit', { outputFile: resolve(__dirname, 'reports/integration.xml') }]]
      : ['default'],
    outputFile: {
      junit: resolve(__dirname, 'reports/integration.xml'),
    },
  },
})
