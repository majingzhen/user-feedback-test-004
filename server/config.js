import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// 这四项来自外部环境，缺失时回退到项目内默认值
export const ROOT_DIR = root
export const PUBLIC_DIR = path.join(root, 'public')
export const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(root, 'data'))
export const MEDIA_DIR = path.join(DATA_DIR, 'media')
export const EXPORTS_DIR = path.join(DATA_DIR, 'exports')
export const WORKSPACE_FILE = path.join(DATA_DIR, 'workspace.json')

export const FFMPEG_PATH = process.env.FFMPEG_PATH || 'ffmpeg'
export const FFPROBE_PATH = process.env.FFPROBE_PATH || 'ffprobe'
export const PORT = Number(process.env.PORT || 5178)
export const HOST = process.env.HOST || '127.0.0.1'
