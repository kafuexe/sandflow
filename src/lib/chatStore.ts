import { create } from "zustand";
import type { AssistantAgent, ChatSummary } from "../../shared/types";
import { api, subscribeChat, type LiveChat } from "./api";
import { useStore } from "./store";

interface ChatState {
  open: boolean;
  flowId: string | null;
  chats: ChatSummary[];
  /** Selected chat id; null = a fresh draft (the chat is created with the first message). */
  chatId: string | null;
  /** Live state of `chatId` once loaded. */
  chat: LiveChat | null;
  sending: boolean;
  error?: string;

  openPanel(flowId: string): Promise<void>;
  close(): void;
  /** The canvas switched flows. */
  flowChanged(flowId: string | null): Promise<void>;
  select(id: string): void;
  newChat(): void;
  send(text: string): Promise<boolean>;
  cancel(): Promise<void>;
  remove(id: string): Promise<void>;
  /** Pick the agent for this chat (and as the default for new ones). */
  setAgent(agent: AssistantAgent): Promise<void>;
}

let unsubscribe: (() => void) | undefined;

const DEFAULT_AGENT: AssistantAgent = { provider: "claudeCode" };
/** The agent new chats start with: the last one picked. */
export const defaultAgent = (): AssistantAgent => useStore.getState().data?.settings.assistantAgent ?? DEFAULT_AGENT;

export const useChatStore = create<ChatState>((set, get) => {
  async function refreshList() {
    const flowId = get().flowId;
    if (!flowId) return;
    try {
      const chats = await api.listChats(flowId);
      if (get().flowId === flowId) set({ chats });
    } catch (e) {
      set({ error: (e as Error).message });
    }
  }

  function watch(id: string) {
    unsubscribe?.();
    let wasRunning: boolean | undefined;
    unsubscribe = subscribeChat(id, (chat) => {
      if (get().chatId !== id) return;
      set({ chat });
      // Keep the list's running dots and order current when a turn starts or ends.
      if (wasRunning !== undefined && wasRunning !== chat.running) void refreshList();
      wasRunning = chat.running;
    });
  }

  function detach() {
    unsubscribe?.();
    unsubscribe = undefined;
  }

  return {
    open: false,
    flowId: null,
    chats: [],
    chatId: null,
    chat: null,
    sending: false,

    async openPanel(flowId) {
      set({ open: true });
      if (get().flowId !== flowId) await get().flowChanged(flowId);
    },
    close() {
      set({ open: false });
    },
    async flowChanged(flowId) {
      if (flowId === get().flowId) return;
      detach();
      set({ flowId, chats: [], chatId: null, chat: null, error: undefined });
      if (!flowId) return;
      await refreshList();
      // Reopen the most recent chat so coming back to a flow picks up where you left off.
      const latest = get().chats[0];
      if (latest && get().flowId === flowId) get().select(latest.id);
    },
    select(id) {
      set({ chatId: id, chat: null, error: undefined });
      watch(id);
    },
    newChat() {
      detach();
      set({ chatId: null, chat: null, error: undefined });
    },
    async send(text) {
      const flowId = get().flowId;
      if (!flowId || !text.trim() || get().sending) return false;
      set({ sending: true, error: undefined });
      try {
        let id = get().chatId;
        if (!id) {
          const created = await api.createChat(flowId, defaultAgent());
          id = created.id;
          set({ chatId: id, chat: { ...created, running: false } });
          watch(id);
        }
        await api.sendChat(id, text);
        void refreshList();
        return true;
      } catch (e) {
        set({ error: (e as Error).message });
        return false;
      } finally {
        set({ sending: false });
      }
    },
    async cancel() {
      const id = get().chatId;
      if (id) await api.cancelChat(id).catch(() => {});
    },
    async remove(id) {
      await api.deleteChat(id).catch((e: Error) => set({ error: e.message }));
      if (get().chatId === id) get().newChat();
      await refreshList();
    },
    async setAgent(agent) {
      useStore.getState().updateSettings({ assistantAgent: agent.model?.trim() ? agent : { provider: agent.provider } });
      const id = get().chatId;
      if (!id) return;
      try {
        set({ chat: await api.setChatAgent(id, agent), error: undefined });
      } catch (e) {
        set({ error: (e as Error).message });
      }
    },
  };
});

/** Is the assistant editing this flow right now (from any of its chats)? */
export const useAssistantEditing = (flowId: string | null | undefined) =>
  useChatStore((s) => !!flowId && s.flowId === flowId && ((s.chat?.running ?? false) || s.chats.some((c) => c.running)));
