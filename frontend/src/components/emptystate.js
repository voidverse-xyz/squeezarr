import { Card } from "@/components/ui/card";

// Centered icon + message (+ optional hint) panel for "nothing here yet" states.
export default function EmptyState({ icon: Icon, title, hint }) {
    return (
        <Card className="p-8 text-center">
            <Icon size={24} className="mx-auto mb-2 text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">{title}</p>
            {hint && <p className="text-xs text-muted-foreground/60 mt-1">{hint}</p>}
        </Card>
    );
}
