declare namespace chrome {
  namespace tabs {
    function query(queryInfo: { active: boolean; currentWindow: boolean }): Promise<Array<{ id?: number }>>;
    function sendMessage(tabId: number, message: unknown, options: { frameId: number }): Promise<unknown>;
  }

  namespace runtime {
    const id: string;
    function sendMessage(message: unknown): Promise<unknown>;
    function openOptionsPage(): Promise<void>;
    function getURL(path: string): string;
    const onInstalled: { addListener(callback: (details: { reason: string }) => void): void };
    interface MessageSender {
      id?: string;
      tab?: { id?: number };
      frameId?: number;
      url?: string;
    }

    const onMessage: {
      addListener(callback: (message: unknown, sender: MessageSender, sendResponse: (response: unknown) => void) => boolean | void): void;
    };
  }
  namespace permissions {
    function request(permissions: { origins: string[] }): Promise<boolean>;
    function contains(permissions: { origins: string[] }): Promise<boolean>;
  }
  namespace storage {
    interface Area {
      get(keys: string | string[]): Promise<Record<string, unknown>>;
      set(values: Record<string, unknown>): Promise<void>;
      remove(keys: string | string[]): Promise<void>;
      setAccessLevel(options: { accessLevel: 'TRUSTED_CONTEXTS' }): Promise<void>;
    }
    const local: Area;
    const session: Area;
  }
  namespace webNavigation {
    function getAllFrames(details: { tabId: number }): Promise<Array<{ frameId: number; parentFrameId: number; url: string }> | null>;
  }
}
