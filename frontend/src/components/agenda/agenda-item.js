import React from "react";
import { Link } from "react-router-dom";

const AgendaItem = ({ task_event, index, currentIndex, onSetActive }) => {
    return (
        <li
            className={"list-group-item " + (index === currentIndex ? "active" : "")}
            onClick={() => onSetActive(task_event, index)}
        >
            <h4>{task_event.type}</h4>
            <div>
{/*
                {plant.type} {plant.type && plant.location ? "•" : ""} {plant.location}
*/}
            </div>
{/*            <Link to={"/plants/" + plant.id} className="badge badge-warning">
                Edit
            </Link>*/}
        </li>
    );
};

export default React.memo(AgendaItem);
