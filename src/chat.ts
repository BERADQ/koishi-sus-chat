export interface ChatRequest {
  model: string;
  messages: Message[];
  stream?: boolean;
}
export interface Message {
  role: "user" | "system" | "assistant";
  content: string;
}
