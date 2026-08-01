import { cn } from "@/lib/utils";

export default function Input({ className, ...props }) {
    return (
        <input
            className={cn(
                "w-full bg-input border border-border rounded px-2.5 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-ring",
                className,
            )}
            {...props}
        />
    );
}
