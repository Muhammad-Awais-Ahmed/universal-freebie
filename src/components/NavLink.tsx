"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export default function NavLink({
  href,
  children,
  icon,
}: {
  href: string;
  children: React.ReactNode;
  icon?: React.ReactNode;
}) {
  const pathname = usePathname();
  const isActive = pathname === href || (href !== "/" && pathname.startsWith(href));

  return (
    <Link
      href={href}
      className={`group relative flex items-center gap-2 px-3.5 py-1.5 rounded-lg text-xs font-semibold uppercase tracking-wider transition-all duration-200 font-gaming no-drag ${
        isActive
          ? "text-white bg-red-500/15 border border-red-500/40 shadow-[0_0_15px_rgba(239,68,68,0.35)]"
          : "text-slate-400 hover:text-white hover:bg-slate-800/40 border border-transparent"
      }`}
    >
      {icon && (
        <span
          className={`transition-colors duration-200 ${
            isActive ? "text-red-400" : "text-slate-400 group-hover:text-blue-400"
          }`}
        >
          {icon}
        </span>
      )}
      <span>{children}</span>
      {isActive && (
        <span className="absolute -bottom-[1px] left-1/2 -translate-x-1/2 w-4 h-[2px] bg-red-400 rounded-full shadow-[0_0_8px_#ef4444]" />
      )}
    </Link>
  );
}
