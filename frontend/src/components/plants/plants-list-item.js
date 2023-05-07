import React from "react";
import { Link } from "react-router-dom";

const PlantsListItem = ({ plant, index, currentIndex, onSetActive }) => {
    return (
        <li
            className={"list-group-item " + (index === currentIndex ? "active" : "")}
            onClick={() => onSetActive(plant, index)}
        >
            <h4>{plant.name}</h4>
            <div>
                {plant.type} {plant.type && plant.location ? "•" : ""} {plant.location}
            </div>
            <Link to={"/plants/" + plant.id} className="badge badge-warning">
                Edit
            </Link>
        </li>
    );
};

export default React.memo(PlantsListItem);
