import { defineConfig } from 'vitest/config'
import solid from 'vite-plugin-solid'

export default defineConfig({
  // Served from https://nicholaspsmith.github.io/DogScheduler/
  base: '/DogScheduler/',
  plugins: [solid()],
  test: {
    // Pure-logic unit tests; also stops vite-plugin-solid from injecting
    // its jsdom default, which isn't installed.
    environment: 'node',
  },
})
