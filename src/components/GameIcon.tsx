import {
  CarFront,
  Crosshair,
  Gamepad2,
  Orbit,
  Shield,
  Snowflake,
  Swords,
  TrainFront,
  type LucideIcon,
} from "lucide-react";

const icons: Record<string, LucideIcon> = {
  "car-front": CarFront,
  crosshair: Crosshair,
  orbit: Orbit,
  shield: Shield,
  snowflake: Snowflake,
  swords: Swords,
  "train-front": TrainFront,
};

export default function GameIcon({ name, className }: { name?: string; className?: string }) {
  const Icon = (name && icons[name]) || Gamepad2;
  return <Icon className={className} aria-hidden="true" />;
}
