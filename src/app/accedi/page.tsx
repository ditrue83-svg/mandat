import { LoginForm } from "@/components/login-form";
import { isDemo } from "@/lib/config";
export const dynamic = "force-dynamic";
export default function Login() {
  return <LoginForm demo={isDemo()} />;
}
