import {
  Braces,
  File,
  FileArchive,
  FileCode2,
  FileCog,
  FileImage,
  FileJson,
  FileKey,
  FileLock,
  FileSpreadsheet,
  FileTerminal,
  FileText,
  FileType,
  FileVideo,
  Folder,
  FolderGit2,
  FolderOpen,
  Hash,
  type LucideIcon
} from 'lucide-react'

/** GitHub mark (lucide dropped brand icons). */
export function GithubMark({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" className={className} aria-hidden>
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  )
}

interface IconSpec {
  Icon: LucideIcon
  color: string
}

const BY_EXT: Record<string, IconSpec> = {}
const set = (exts: string, Icon: LucideIcon, color: string) => exts.split(' ').forEach((e) => (BY_EXT[e] = { Icon, color }))
set('ts tsx mts cts', FileCode2, '#6b9bff')
set('js jsx mjs cjs', FileCode2, '#f5c06b')
set('json jsonc json5 webmanifest', FileJson, '#f5b740')
set('md mdx markdown txt rst', FileText, '#9fb4d8')
set('css scss sass less', Hash, '#c084fc')
set('html htm vue svelte astro xml', FileCode2, '#ff7a45')
set('py pyi', FileCode2, '#3ecf8e')
set('rs', FileCode2, '#ff7a59')
set('go', FileCode2, '#67d4f1')
set('rb', FileCode2, '#f43f5e')
set('java kt kts swift c h cpp cc hpp cs php lua pl r', FileCode2, '#e8a87c')
set('sh bash zsh fish', FileTerminal, '#3ecf8e')
set('yml yaml toml ini cfg conf env properties', FileCog, '#a8a29e')
set('png jpg jpeg gif webp avif bmp ico svg', FileImage, '#f472b6')
set('mp4 mov webm mkv', FileVideo, '#f472b6')
set('zip tar gz tgz bz2 xz 7z rar', FileArchive, '#a8a29e')
set('csv tsv xlsx xls', FileSpreadsheet, '#3ecf8e')
set('lock', FileLock, '#8f857b')
set('pem key crt', FileKey, '#f5b740')
set('ttf otf woff woff2', FileType, '#a8a29e')
set('graphql gql prisma sql', Braces, '#ff6bb5')

export function fileIcon(name: string): IconSpec {
  const n = name.toLowerCase()
  if (n === 'package.json' || n === 'tsconfig.json') return { Icon: FileJson, color: '#3ecf8e' }
  if (n.startsWith('.env')) return { Icon: FileKey, color: '#f5b740' }
  if (n.startsWith('.git')) return { Icon: FileCog, color: '#ff4a2b' }
  if (n === 'dockerfile' || n === 'makefile') return { Icon: FileTerminal, color: '#67d4f1' }
  const ext = n.includes('.') ? n.split('.').pop()! : ''
  return BY_EXT[ext] ?? { Icon: File, color: '#8f857b' }
}

export function FileIcon({ name, size = 14 }: { name: string; size?: number }) {
  const { Icon, color } = fileIcon(name)
  return <Icon size={size} style={{ color, flex: 'none' }} />
}

export function FolderIcon({ open, name, size = 14 }: { open?: boolean; name?: string; size?: number }) {
  if (name === '.github') return <FolderGit2 size={size} style={{ color: '#c9a77c', flex: 'none' }} />
  const I = open ? FolderOpen : Folder
  return <I size={size} style={{ color: '#c9a77c', flex: 'none' }} />
}
