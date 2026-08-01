// Small icon + label header used atop the dashboard's summary widgets (and reusable by any tab
// that wants a titled section). Icon and label are vertically centered.
export default function SectionHeader({ icon: Icon, label }) {
    return (
        <div className="mb-3 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <Icon size={13} />
            {label}
        </div>
    );
}
