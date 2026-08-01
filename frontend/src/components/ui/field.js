// Labelled form row: a label/description column beside a wider control column.
export default function Field({ label, description, children }) {
    return (
        <div className="grid grid-cols-3 gap-4 items-start">
            <div className="pt-1.5">
                <div className="text-sm">{label}</div>
                {description && <p className="text-[11px] text-muted-foreground mt-0.5 leading-snug">{description}</p>}
            </div>
            <div className="col-span-2">{children}</div>
        </div>
    );
}
