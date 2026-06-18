import { BrowserRouter } from "react-router-dom";
import { SessionProvider } from "../session/SessionProvider";
import { AppRoutes } from "./routes";

export function App() {
  return (
    <BrowserRouter>
      <SessionProvider>
        <AppRoutes />
      </SessionProvider>
    </BrowserRouter>
  );
}
