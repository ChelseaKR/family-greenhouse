import React from "react";

const SearchBar = ({ value, onChange, onSearch }) => {
    return (
        <div className="input-group mb-3">
            <input
                type="text"
                className="form-control"
                placeholder="Search by name"
                value={value}
                onChange={onChange}
            />
            <div className="input-group-append">
                <button className="btn btn-outline-secondary" type="button" onClick={onSearch}>
                    Search
                </button>
            </div>
        </div>
    );
};

export default React.memo(SearchBar);
