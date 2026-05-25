import { drizzleAdapter } from '@better-auth/drizzle-adapter'
import { betterAuth } from 'better-auth'
import { username } from 'better-auth/plugins'
import { tanstackStartCookies } from 'better-auth/tanstack-start'
import { db } from './db'
import * as schema from './db/schema'
import { getAppBaseUrl, getAuthSecret } from './env'

export const auth = betterAuth({
  secret: getAuthSecret(),
  baseURL: getAppBaseUrl(),
  basePath: '/api/auth',
  trustedOrigins: [
    getAppBaseUrl(),
    'http://localhost:3000',
    'http://127.0.0.1:3000',
  ],
  database: drizzleAdapter(db, {
    provider: 'sqlite',
    schema,
  }),
  emailAndPassword: {
    enabled: true,
    password: {
      hash: async (password) => {        const enc = new TextEncoder()
        const keyMaterial = await crypto.subtle.importKey(
          'raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']
        )
        const salt = crypto.getRandomValues(new Uint8Array(16))
        const bits = await crypto.subtle.deriveBits(
          { name: 'PBKDF2', salt, iterations: 1000, hash: 'SHA-256' },
          keyMaterial, 256
        )
        const hashArr = Array.from(new Uint8Array(bits))
        const saltArr = Array.from(salt)
        return JSON.stringify({ salt: saltArr, hash: hashArr })
      },
      verify: async ({ hash: stored, password }) => {
        try {
          const { salt: saltArr, hash: hashArr } = JSON.parse(stored)
          const enc = new TextEncoder()
          const keyMaterial = await crypto.subtle.importKey(
            'raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']
          )
          const bits = await crypto.subtle.deriveBits(
            { name: 'PBKDF2', salt: new Uint8Array(saltArr), iterations: 1000, hash: 'SHA-256' },
            keyMaterial, 256
          )
          const newHash = Array.from(new Uint8Array(bits))
          return newHash.every((b, i) => b === hashArr[i])
        } catch {
          return false
        }
      },
    },
  },
  plugins: [username(), tanstackStartCookies()],
})
