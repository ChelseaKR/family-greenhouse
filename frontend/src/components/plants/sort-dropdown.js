import React from "react";

const SortDropdown = ({ onChange }) => {
    return (
        <div style={{ display: "inline-block", marginRight: "2em" }}>
            Sort by:
            <select className="custom-select custom-select-sm custom-dropdown ml-2" onChange={onChange}>
                <option value="">Select</option>
                <option value="name_asc">Name (A-Z)</option>
                <option value="name_desc">Name (Z-A)</option>
                <option value="type_asc">Type (A-Z)</option>
                <option value="type_desc">Type (Z-A)</option>
                <option value="location_asc">Location (A-Z)</option>
                <option value="location_desc">Location (Z-A)</option>
            </select>
        </div>
    );
};

export default React.memo(SortDropdown);
