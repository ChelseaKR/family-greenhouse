import React from "react";

const SearchBar = ({ value, onChange }) => {
    const handleChange = (event) => {
        const { value } = event.target;
        onChange(value);
    };

    return (
        <div className="input-group mb-3">
            <input
                type="text"
                className="form-control"
                placeholder="Search by name"
                value={value}
                onChange={handleChange}
            />
        </div>
    );
};

export default React.memo(SearchBar);
