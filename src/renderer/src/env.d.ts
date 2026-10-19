declare module '*.css'
declare module '*?worker' {
  const WorkerFactory: new () => Worker
  export default WorkerFactory
}
declare module '*?url' {
  const url: string
  export default url
}
