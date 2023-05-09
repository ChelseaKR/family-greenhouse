import React from "react";
import { Link } from "react-router-dom";

const HistoryItem = ({ event, index, currentIndex, onSetActive }) => {
    if (!event) {
        return (
            <tr>
                <td colSpan="5">No event data available.</td>
            </tr>
        );
    }

    console.log(JSON.stringify(event));
    return (
        <tr
            className={index === currentIndex ? "table-active" : ""}
            onClick={() => onSetActive(event, index)}
        >
            <td>{event.datetime.slice(0, 10)}</td>
            <td>{event.task ? event.task.task_type : ""}</td>
            <td>{event.task.plant ? event.task.plant.name : ""}</td>
            <td>{event.task.plant ? event.task.plant.type : ""}</td>
            <td>{event.is_completed ? "Yes" : "No"}</td>
            <td>{event.completed_by}</td>
            <td>{event.date_completed}</td>
        </tr>
    );
};

export default React.memo(HistoryItem);
