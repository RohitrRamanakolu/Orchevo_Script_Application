import Stack from "@mui/material/Stack";
import type { ChatItem } from "../types";
import MessageBubble from "./MessageBubble";
import ErrorMessage from "./ErrorMessage";

interface MessageListProps {
  items: ChatItem[];
  onRetry: (query: string) => void;
}

export default function MessageList({ items, onRetry }: MessageListProps) {
  return (
    <Stack spacing={2}>
      {items.map((item) =>
        item.kind === "error" ? (
          <ErrorMessage key={item.id} detail={item.detail} onRetry={() => onRetry(item.retryQuery)} />
        ) : (
          <MessageBubble key={item.id} message={item} />
        )
      )}
    </Stack>
  );
}
