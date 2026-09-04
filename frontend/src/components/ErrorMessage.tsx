import Box from "@mui/material/Box";
import Button from "@mui/material/Button";

interface ErrorMessageProps {
  detail: string;
  onRetry?: () => void;
}

export default function ErrorMessage({ detail, onRetry }: ErrorMessageProps) {
  return (
    <Box
      sx={{
        color: "error.main",
        px: 1.75,
        py: 1.25,
        borderRadius: "6px",
        bgcolor: "rgba(198,40,40,0.06)",
        border: "1px solid rgba(198,40,40,0.2)",
        fontSize: 13,
        display: "flex",
        alignItems: "center",
        gap: 1,
      }}
    >
      ⚠️ {detail}
      {onRetry && (
        <Button
          onClick={onRetry}
          size="small"
          sx={{
            ml: "auto",
            px: 1.75,
            py: 0.5,
            borderRadius: "6px",
            border: "1px solid rgba(198,40,40,0.3)",
            color: "error.main",
            fontSize: 12,
            "&:hover": { bgcolor: "rgba(198,40,40,0.08)" },
          }}
        >
          Retry
        </Button>
      )}
    </Box>
  );
}
