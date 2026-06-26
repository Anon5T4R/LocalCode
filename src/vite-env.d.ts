/// <reference types="vite/client" />

declare module "*?worker" {
  const worker: { new (): Worker };
  export default worker;
}
