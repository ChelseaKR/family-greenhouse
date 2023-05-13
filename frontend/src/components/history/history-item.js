import React, { useState } from "react";
import axios from 'axios';

const HistoryItem = ({ event, index, currentIndex, onSetActive }) => {
    const [isCompleted, setIsCompleted] = useState(event.is_completed);
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState(null);

    const handleCheckboxChange = async () => {
        setIsLoading(true);
        try {
            const response = await axios.put(`${process.env.REACT_APP_APP_API_URL}/history/${event.id}`, { is_completed: !isCompleted });
            setIsCompleted(!isCompleted);
            setError(null);
        } catch (err) {
            setError(err.response?.data?.message || 'An unspecified error occurred');
        } finally {
            setIsLoading(false);
        }
    };

    if (!event) {
        return (
            <tr>
                <td colSpan="5">No event data available.</td>
            </tr>
        );
    }

    console.log(JSON.stringify(event));
    return (
        <>
            {error && <div>{error}</div>}
            <tr
                className={index === currentIndex ? "table-active" : ""}
                onClick={() => onSetActive(event, index)}
            >
                <td data-label="Completed?">
                    <input
                        type="checkbox"
                        checked={isCompleted}
                        disabled={isLoading}
                        onChange={handleCheckboxChange}
                    />
                </td>
                <td data-label="Date/Time">{event.datetime}</td>
                <td data-label="Task">{event.task ? event.task.task_type : ""}</td>
                <td data-label="Plant Name">{event.task.plant ? event.task.plant.name : ""}</td>
                <td data-label="Plant Type">{event.task.plant ? event.task.plant.type : ""}</td>
                <td data-label="Completed By">{event.completed_by}</td>
                <td data-label="Date Completed">{event.date_completed}</td>
            </tr>
        </>
    );
};

export default React.memo(HistoryItem);
