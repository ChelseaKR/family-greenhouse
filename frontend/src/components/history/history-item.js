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
                <td>
                    <input
                        type="checkbox"
                        checked={isCompleted}
                        disabled={isLoading}
                        onChange={handleCheckboxChange}
                    />
                </td>
                <td>{event.datetime.slice(0, 10)}</td>
                <td>{event.task ? event.task.task_type : ""}</td>
                <td>{event.task.plant ? event.task.plant.name : ""}</td>
                <td>{event.task.plant ? event.task.plant.type : ""}</td>

                <td>{event.completed_by}</td>
                <td>{event.date_completed}</td>
            </tr>
        </>
    );
};

export default React.memo(HistoryItem);
