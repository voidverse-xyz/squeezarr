import { cn } from "@/lib/utils";

// The dashboard's surface primitive: the `bg-card border border-border rounded` panel used by
// every widget, stat card, and table wrapper. Pass extra classes (padding, layout) via className.
export function Card({ className, ...props }) {
    return <div data-slot="card" className={cn("bg-card border border-border rounded", className)} {...props} />;
}
