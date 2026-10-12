import { isAbsolute, normalize } from 'node:path'
export const pathIsAbsolute = path => Boolean(path) && isAbsolute(path)
export const normalizePath = path => normalize(path || '')
