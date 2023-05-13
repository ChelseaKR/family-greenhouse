import React, {useEffect, useRef, useState} from "react";
import axios from 'axios';
import { useAuth0 } from "@auth0/auth0-react";

const HistoryItemComponent = ({ event, index, currentIndex, onSetActive }) => {
    const [isCompleted, setIsCompleted] = useState(event.is_completed);
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState(null);
    const isMounted = useRef(true);
    const { user } = useAuth0();

    useEffect(() => {
        return () => {
            isMounted.current = false;
        };
    }, []);

    const handleCheckboxChange = async () => {
        setIsLoading(true);
        const completed_by = !isCompleted ? user.email : null;
        const date_completed = !isCompleted ? new Date() : null;

        try {
            const response = await axios.put(
                `${process.env.REACT_APP_APP_API_URL}/history/${event.id}`,
                {
                    is_completed: !isCompleted,
                    completed_by: completed_by,
                    date_completed: date_completed
                }
            );
            setError(null);

            event.is_completed = !isCompleted;
            event.completed_by = completed_by;
            event.date_completed = date_completed;
            setIsCompleted(!isCompleted);
        } catch (err) {
            setError(err.response?.data?.message || 'An unspecified error occurred');
        } finally {
            if (isMounted.current) {
                setIsLoading(false);
            }
        }
    };

    if (!event) {
        return (
            <tr>
                <td colSpan="5">No event data available.</td>
            </tr>
        );
    }

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
                <td data-label="Date Completed">{event.date_completed ? new Date(event.date_completed).toLocaleString() : ""}</td>            </tr>
        </>
    );
};

export default React.memo(HistoryItemComponent);
