interface TicketRecord {
    channelId: string;
    userId: string;
    email: string;
    role: string | null;
    expiresAt: number;
}
export declare function issueChatWsTicket(input: {
    channelId: string;
    userId: string;
    email: string;
    role?: string | null;
}, ttlMs?: number): {
    ticket: string;
    expiresInMs: number;
};
export declare function consumeChatWsTicket(ticket: string | null, channelId: string): TicketRecord | null;
export declare function clearChatWsTicketsForTests(): void;
export {};
