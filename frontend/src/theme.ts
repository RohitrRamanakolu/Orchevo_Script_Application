import { createTheme } from "@mui/material/styles";

/**
 * Odisha Government inspired light theme — saffron / navy / white,
 * mirroring the original static site's design tokens.
 */
export const theme = createTheme({
  palette: {
    mode: "light",
    primary: {
      main: "#e8721a",
      light: "#f7941d",
      dark: "#c25e12",
      contrastText: "#ffffff",
    },
    secondary: {
      main: "#1a3a5c",
      light: "#2d5a8e",
      dark: "#0d2137",
      contrastText: "#ffffff",
    },
    success: { main: "#2e7d32", light: "#4caf50" },
    error: { main: "#c62828" },
    warning: { main: "#f57f17" },
    text: {
      primary: "#1a1a2e",
      secondary: "#4a5568",
      disabled: "#94a3b8",
    },
    background: {
      default: "#f7f8fa",
      paper: "#ffffff",
    },
    divider: "#e2e8f0",
  },
  shape: {
    borderRadius: 10,
  },
  typography: {
    fontFamily: "'Noto Sans', 'Noto Sans Oriya', system-ui, -apple-system, sans-serif",
  },
  components: {
    MuiButton: {
      styleOverrides: {
        root: { textTransform: "none" },
      },
    },
  },
});
