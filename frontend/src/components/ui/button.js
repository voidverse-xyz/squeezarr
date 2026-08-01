import { cn } from "@/lib/utils";

// Button — a native <button> with the handful of variants/sizes this app actually uses. Replaces
// the former shadcn button (Base UI primitive + cva); we never needed that machinery here. Add an
// entry to VARIANTS/SIZES if a new style is needed. The `[&_svg…]` rules size unsized lucide icons.
const VARIANTS = {
    default: "bg-primary text-primary-foreground hover:bg-primary/80",
    outline:
        "border-border bg-background hover:bg-muted hover:text-foreground dark:border-input dark:bg-input/30 dark:hover:bg-input/50",
    ghost: "hover:bg-muted hover:text-foreground dark:hover:bg-muted/50",
    destructive: "bg-destructive/10 text-destructive hover:bg-destructive/20",
};

const SIZES = {
    default: "h-8 gap-1.5 px-2.5 [&_svg:not([class*='size-'])]:size-4",
    sm: "h-7 gap-1 px-2.5 [&_svg:not([class*='size-'])]:size-3.5",
};

export function Button({ className, variant = "default", size = "default", ...props }) {
    return (
        <button
            className={cn(
                "inline-flex shrink-0 items-center justify-center rounded-none border border-transparent text-xs font-medium whitespace-nowrap transition-colors outline-none select-none focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0",
                VARIANTS[variant],
                SIZES[size],
                className,
            )}
            {...props}
        />
    );
}
