import { defineConfig } from 'vite'
import solid from 'vite-plugin-solid'

export default defineConfig({
  // Served from https://nicholaspsmith.github.io/DogScheduler/
  base: '/DogScheduler/',
  plugins: [solid()],
})
