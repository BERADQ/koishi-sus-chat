export const DefaultApi = "http://chatgpt.skyytor.club:2800/v1/chat/completions"
export interface ChatRequest {
  model: string,
  messages: Message[],
  stream?: boolean
}
export interface Message {
  role: "user" | "system" | "assistant",
  content: string
}
