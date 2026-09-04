import { keyframes } from "@mui/material/styles";
import Box from "@mui/material/Box";

const dotBounce = keyframes`
  0%, 80%, 100% { transform: scale(0.6); opacity: 0.4; }
  40%           { transform: scale(1); opacity: 1; }
`;

export default function ThinkingDots() {
  return (
    <Box sx={{ display: "flex", gap: "4px", py: "4px" }}>
      {[0, 0.2, 0.4].map((delay) => (
        <Box
          key={delay}
          sx={{
            width: 6,
            height: 6,
            borderRadius: "50%",
            bgcolor: "primary.main",
            animation: `${dotBounce} 1.4s ease-in-out infinite`,
            animationDelay: `${delay}s`,
          }}
        />
      ))}
    </Box>
  );
}
